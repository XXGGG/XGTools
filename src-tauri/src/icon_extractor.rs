use base64::Engine;
use std::path::Path;

// DI_NORMAL = DI_IMAGE | DI_MASK = 0x0003
const DI_NORMAL: u32 = 0x0003;

/// Extract the icon from a Windows .exe file and return as base64 PNG data URI.
/// Uses SHGetImageList with SHIL_JUMBO to get 256x256 high-res icons.
/// Falls back to SHIL_EXTRALARGE (48x48) then ExtractIconEx (32x32) if needed.
pub fn extract_exe_icon(exe_path: &str, icons_dir: &Path) -> Result<String, String> {

    // Try JUMBO (256x256) first, then EXTRALARGE (48x48)
    let icon_sizes: &[(i32, i32)] = &[
        (0x4, 256), // SHIL_JUMBO = 0x4, 256x256
        (0x2, 48),  // SHIL_EXTRALARGE = 0x2, 48x48
    ];

    for &(shil_flag, expected_size) in icon_sizes {
        if let Ok(result) = extract_via_imagelist(exe_path, icons_dir, shil_flag, expected_size) {
            return Ok(result);
        }
    }

    // Final fallback: ExtractIconEx (32x32)
    extract_via_extracticonex(exe_path, icons_dir)
}

/// Extract icon using SHGetImageList COM interface for high-res icons
fn extract_via_imagelist(
    exe_path: &str,
    icons_dir: &Path,
    shil_flag: i32,
    size: i32,
) -> Result<String, String> {
    use std::mem;
    use std::ptr;
    use winapi::shared::guiddef::GUID;
    use winapi::shared::minwindef::UINT;
    use winapi::um::combaseapi::CoInitializeEx;
    use winapi::um::commoncontrols::IImageList;
    use winapi::um::libloaderapi::{LoadLibraryA, GetProcAddress};
    use winapi::um::objbase::COINIT_APARTMENTTHREADED;
    use winapi::um::shellapi::{SHGetFileInfoW, SHFILEINFOW, SHGFI_SYSICONINDEX};
    use winapi::um::wingdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use winapi::um::winuser::{DrawIconEx, DestroyIcon, GetDC, ReleaseDC};

    // IID_IImageList = {46EB5926-582E-4017-9FDF-E8998DAA0950}
    let iid_iimagelist = GUID {
        Data1: 0x46EB5926,
        Data2: 0x582E,
        Data3: 0x4017,
        Data4: [0x9F, 0xDF, 0xE8, 0x99, 0x8D, 0xAA, 0x09, 0x50],
    };

    let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        // Init COM (ignore already-initialized error)
        let _ = CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED);

        // Get icon index in system image list
        let mut shfi: SHFILEINFOW = mem::zeroed();
        let result = SHGetFileInfoW(
            wide_path.as_ptr(),
            0,
            &mut shfi,
            mem::size_of::<SHFILEINFOW>() as UINT,
            SHGFI_SYSICONINDEX,
        );

        if result == 0 {
            return Err("SHGetFileInfo failed".to_string());
        }

        let icon_index = shfi.iIcon;

        // SHGetImageList to get the image list COM object
        // extern "system" fn SHGetImageList(iImageList: i32, riid: *const GUID, ppvObj: *mut *mut c_void) -> HRESULT
        type SHGetImageListFn = unsafe extern "system" fn(
            i32,
            *const GUID,
            *mut *mut std::ffi::c_void,
        ) -> i32;

        let shell32 = LoadLibraryA(b"shell32.dll\0".as_ptr() as *const i8);
        if shell32.is_null() {
            return Err("Failed to load shell32.dll".to_string());
        }

        let func = GetProcAddress(
            shell32,
            b"SHGetImageList\0".as_ptr() as *const i8,
        );
        if func.is_null() {
            return Err("Failed to find SHGetImageList".to_string());
        }

        let sh_get_image_list: SHGetImageListFn = mem::transmute(func);
        let mut image_list: *mut std::ffi::c_void = ptr::null_mut();
        let hr = sh_get_image_list(shil_flag, &iid_iimagelist, &mut image_list);

        if hr != 0 || image_list.is_null() {
            return Err(format!("SHGetImageList failed: 0x{:08X}", hr));
        }

        let image_list = image_list as *mut IImageList;

        // GetIcon from image list
        let mut hicon = ptr::null_mut();
        let hr = (*image_list).GetIcon(icon_index, 0x00000001, &mut hicon); // ILD_TRANSPARENT = 1
        // Release the image list (we don't call Release since we got it via raw pointer — it's managed by shell)

        if hr != 0 || hicon.is_null() {
            return Err("GetIcon failed".to_string());
        }

        // Render icon to bitmap
        let hdc_screen = GetDC(ptr::null_mut());
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        let hbmp = CreateCompatibleBitmap(hdc_screen, size, size);
        let old_bmp = SelectObject(hdc_mem, hbmp as _);

        // Fill background with transparent (all zeros for BGRA pre-multiplied)
        let mut bmi: BITMAPINFO = mem::zeroed();
        bmi.bmiHeader.biSize = mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = size;
        bmi.bmiHeader.biHeight = -size; // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        // Clear the DC with transparent pixels
        let clear_pixels = vec![0u8; (size * size * 4) as usize];
        winapi::um::wingdi::SetDIBitsToDevice(
            hdc_mem,
            0, 0,
            size as u32, size as u32,
            0, 0, 0, size as u32,
            clear_pixels.as_ptr() as *const _,
            &bmi,
            DIB_RGB_COLORS,
        );

        // Draw the icon
        DrawIconEx(hdc_mem, 0, 0, hicon, size, size, 0, ptr::null_mut(), DI_NORMAL);

        // Read pixels
        let mut pixels = vec![0u8; (size * size * 4) as usize];
        GetDIBits(
            hdc_mem,
            hbmp,
            0,
            size as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // Cleanup GDI
        SelectObject(hdc_mem, old_bmp);
        DeleteObject(hbmp as _);
        DeleteDC(hdc_mem);
        ReleaseDC(ptr::null_mut(), hdc_screen);
        DestroyIcon(hicon);

        // Convert BGRA to RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        // Check if image is entirely transparent (failed extraction)
        let has_content = pixels.chunks_exact(4).any(|c| c[3] > 0);
        if !has_content {
            return Err("Extracted icon is entirely transparent".to_string());
        }

        // Create PNG
        let img = image::RgbaImage::from_raw(size as u32, size as u32, pixels)
            .ok_or("Failed to create image buffer")?;

        // Save to icons dir
        let file_stem = Path::new(exe_path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let png_path = icons_dir.join(format!("{}.png", file_stem));
        img.save(&png_path)
            .map_err(|e| format!("Failed to save icon: {}", e))?;

        // Encode as base64
        let mut buf = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buf);
        use image::ImageEncoder;
        encoder
            .write_image(
                img.as_raw(),
                size as u32,
                size as u32,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("Failed to encode PNG: {}", e))?;

        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Ok(format!("data:image/png;base64,{}", b64))
    }
}

/// Fallback: extract using ExtractIconExW (only 32x32)
fn extract_via_extracticonex(exe_path: &str, icons_dir: &Path) -> Result<String, String> {
    use std::ptr;
    use winapi::um::shellapi::ExtractIconExW;
    use winapi::um::wingdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use winapi::um::winuser::{DestroyIcon, GetIconInfo, ICONINFO};

    let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut large_icon = ptr::null_mut();
        let count = ExtractIconExW(wide_path.as_ptr(), 0, &mut large_icon, ptr::null_mut(), 1);

        if count == 0 || large_icon.is_null() {
            return Err("No icon found in executable".to_string());
        }

        let mut icon_info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(large_icon, &mut icon_info) == 0 {
            DestroyIcon(large_icon);
            return Err("Failed to get icon info".to_string());
        }

        let hdc = CreateCompatibleDC(ptr::null_mut());
        let mut bmp_info: BITMAPINFO = std::mem::zeroed();
        bmp_info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;

        // First call to get dimensions
        GetDIBits(
            hdc,
            icon_info.hbmColor,
            0,
            0,
            ptr::null_mut(),
            &mut bmp_info,
            DIB_RGB_COLORS,
        );

        let width = bmp_info.bmiHeader.biWidth;
        let height = bmp_info.bmiHeader.biHeight.abs();

        // Setup for 32-bit BGRA
        bmp_info.bmiHeader.biBitCount = 32;
        bmp_info.bmiHeader.biCompression = BI_RGB;
        bmp_info.bmiHeader.biHeight = -height; // top-down
        bmp_info.bmiHeader.biSizeImage = (width * height * 4) as u32;

        let mut pixels = vec![0u8; (width * height * 4) as usize];

        let old = SelectObject(hdc, icon_info.hbmColor as _);
        GetDIBits(
            hdc,
            icon_info.hbmColor,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bmp_info,
            DIB_RGB_COLORS,
        );
        SelectObject(hdc, old);

        // Convert BGRA to RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        // Create PNG using image crate
        let img = image::RgbaImage::from_raw(width as u32, height as u32, pixels)
            .ok_or("Failed to create image buffer")?;

        // Save PNG to icons dir
        let file_stem = Path::new(exe_path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let png_path = icons_dir.join(format!("{}.png", file_stem));
        img.save(&png_path)
            .map_err(|e| format!("Failed to save icon: {}", e))?;

        // Encode as base64
        let mut buf = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buf);
        use image::ImageEncoder;
        encoder
            .write_image(
                img.as_raw(),
                width as u32,
                height as u32,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("Failed to encode PNG: {}", e))?;

        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);

        // Cleanup GDI objects
        DeleteDC(hdc);
        DeleteObject(icon_info.hbmColor as _);
        DeleteObject(icon_info.hbmMask as _);
        DestroyIcon(large_icon);

        Ok(format!("data:image/png;base64,{}", b64))
    }
}

/// Resolve a Windows .lnk shortcut file to get target path and display name.
/// Uses Windows COM API (IShellLinkW) for correct Unicode path resolution.
pub fn resolve_shortcut(lnk_path: &str) -> Result<(String, String), String> {
    use std::ptr;
    use winapi::um::combaseapi::{CoCreateInstance, CoInitializeEx};
    use winapi::um::objbase::COINIT_APARTMENTTHREADED;
    use winapi::shared::minwindef::MAX_PATH;
    use winapi::shared::wtypesbase::CLSCTX_INPROC_SERVER;
    use winapi::um::shobjidl_core::IShellLinkW;
    use winapi::um::objidl::IPersistFile;
    use winapi::Interface;

    // CLSID_ShellLink = {00021401-0000-0000-C000-000000000046}
    let clsid_shell_link = winapi::shared::guiddef::GUID {
        Data1: 0x00021401,
        Data2: 0x0000,
        Data3: 0x0000,
        Data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    let wide_path: Vec<u16> = lnk_path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let _ = CoInitializeEx(ptr::null_mut(), COINIT_APARTMENTTHREADED);

        let mut psl: *mut IShellLinkW = ptr::null_mut();
        let hr = CoCreateInstance(
            &clsid_shell_link,
            ptr::null_mut(),
            CLSCTX_INPROC_SERVER,
            &IShellLinkW::uuidof(),
            &mut psl as *mut *mut _ as *mut *mut _,
        );
        if hr != 0 || psl.is_null() {
            return Err(format!("CoCreateInstance failed: 0x{:08X}", hr));
        }

        // QueryInterface for IPersistFile
        let mut ppf: *mut IPersistFile = ptr::null_mut();
        let hr = (*(psl as *mut winapi::um::unknwnbase::IUnknown)).QueryInterface(
            &IPersistFile::uuidof(),
            &mut ppf as *mut *mut _ as *mut *mut _,
        );
        if hr != 0 || ppf.is_null() {
            (*psl).Release();
            return Err("QueryInterface IPersistFile failed".to_string());
        }

        // Load the .lnk file
        let hr = (*ppf).Load(wide_path.as_ptr(), 0);
        if hr != 0 {
            (*ppf).Release();
            (*psl).Release();
            return Err(format!("IPersistFile::Load failed: 0x{:08X}", hr));
        }

        // GetPath — get the target path (Unicode)
        let mut target_buf = [0u16; MAX_PATH];
        let mut fd: winapi::um::minwinbase::WIN32_FIND_DATAW = std::mem::zeroed();
        let hr = (*psl).GetPath(
            target_buf.as_mut_ptr(),
            target_buf.len() as i32,
            &mut fd,
            0, // SLGP_RAWPATH
        );

        let target_path = if hr == 0 {
            let len = target_buf.iter().position(|&c| c == 0).unwrap_or(target_buf.len());
            String::from_utf16_lossy(&target_buf[..len])
        } else {
            String::new()
        };

        (*ppf).Release();
        (*psl).Release();

        if target_path.is_empty() {
            return Err("Failed to resolve shortcut target".to_string());
        }

        let display_name = std::path::Path::new(lnk_path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        Ok((target_path, display_name))
    }
}
