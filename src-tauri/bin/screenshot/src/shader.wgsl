// XGTools Screenshot Overlay Shader
// 功能: 暗色遮罩 + 选区高亮 + 选区边框 + 十字准线

struct Uniforms {
    screen_size: vec2<f32>,       // 屏幕尺寸 (像素)
    mouse_pos: vec2<f32>,         // 鼠标位置 (像素)
    sel_start: vec2<f32>,         // 选区起点 (像素)
    sel_end: vec2<f32>,           // 选区终点 (像素)
    time: f32,                    // 动画时间 (秒)
    state: u32,                   // 0=idle, 1=dragging, 2=confirmed
    _pad0: f32,
    _pad1: f32,
};

@group(0) @binding(0) var screenshot_texture: texture_2d<f32>;
@group(0) @binding(1) var screenshot_sampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) tex_coords: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = vec4<f32>(in.position, 0.0, 1.0);
    out.tex_coords = in.tex_coords;
    return out;
}

// 判断像素是否在选区内
fn is_in_selection(pixel: vec2<f32>) -> bool {
    let min_x = min(u.sel_start.x, u.sel_end.x);
    let max_x = max(u.sel_start.x, u.sel_end.x);
    let min_y = min(u.sel_start.y, u.sel_end.y);
    let max_y = max(u.sel_start.y, u.sel_end.y);
    return pixel.x >= min_x && pixel.x <= max_x && pixel.y >= min_y && pixel.y <= max_y;
}

// 判断像素是否在选区边框上（2px 宽度, 虚线动画）
fn is_on_border(pixel: vec2<f32>) -> bool {
    let min_x = min(u.sel_start.x, u.sel_end.x);
    let max_x = max(u.sel_start.x, u.sel_end.x);
    let min_y = min(u.sel_start.y, u.sel_end.y);
    let max_y = max(u.sel_start.y, u.sel_end.y);

    let border_width = 1.5;

    let on_left = pixel.x >= min_x - border_width && pixel.x <= min_x + border_width
                  && pixel.y >= min_y - border_width && pixel.y <= max_y + border_width;
    let on_right = pixel.x >= max_x - border_width && pixel.x <= max_x + border_width
                   && pixel.y >= min_y - border_width && pixel.y <= max_y + border_width;
    let on_top = pixel.y >= min_y - border_width && pixel.y <= min_y + border_width
                 && pixel.x >= min_x - border_width && pixel.x <= max_x + border_width;
    let on_bottom = pixel.y >= max_y - border_width && pixel.y <= max_y + border_width
                    && pixel.x >= min_x - border_width && pixel.x <= max_x + border_width;

    if !(on_left || on_right || on_top || on_bottom) {
        return false;
    }

    // 虚线动画: 沿边框方向的虚线
    let dash_len = 6.0;
    let gap_len = 4.0;
    let speed = 30.0;
    var t: f32;
    if on_left || on_right {
        t = pixel.y + u.time * speed;
    } else {
        t = pixel.x + u.time * speed;
    }
    let period = dash_len + gap_len;
    let phase = t % period;
    return phase < dash_len;
}

// 十字准线
fn is_crosshair(pixel: vec2<f32>) -> bool {
    let thickness = 0.5;
    let on_h = abs(pixel.y - u.mouse_pos.y) < thickness;
    let on_v = abs(pixel.x - u.mouse_pos.x) < thickness;
    // 十字线不画在选区内部
    if u.state > 0u && is_in_selection(pixel) {
        return false;
    }
    return on_h || on_v;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let tex_color = textureSample(screenshot_texture, screenshot_sampler, in.tex_coords);
    let pixel = in.tex_coords * u.screen_size;

    // 基础颜色 = 截图纹理
    var color = tex_color;

    if u.state > 0u {
        // 有选区时：选区外加暗色遮罩
        if is_in_selection(pixel) {
            // 选区内：显示原图
            color = tex_color;
        } else {
            // 选区外：暗色遮罩 (40% 黑色)
            color = vec4<f32>(tex_color.rgb * 0.4, 1.0);
        }

        // 选区边框
        if is_on_border(pixel) {
            // 白色虚线边框
            color = vec4<f32>(1.0, 1.0, 1.0, 1.0);
        }
    } else {
        // 无选区：全屏微暗 (让用户知道进入了截图模式)
        color = vec4<f32>(tex_color.rgb * 0.6, 1.0);
    }

    // 十字准线 (Idle 和 Dragging 状态显示)
    if u.state < 2u && is_crosshair(pixel) {
        // 半透明白色十字线
        color = mix(color, vec4<f32>(0.8, 0.8, 0.8, 1.0), 0.6);
    }

    return color;
}
