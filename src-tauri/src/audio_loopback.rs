/*!
把「电脑正在放的声音」抓出来。

# 为什么要自己抓

ffmpeg 在 Windows 上只有 `dshow`，而 dshow 只认**录音设备** —— 系统声音不是录音设备。
老办法是让人在声音设置里打开「立体声混音」，可那东西是主板集成声卡才有的；
USB 声卡、蓝牙耳机一概没有。再往下就是装虚拟声卡驱动，要管理员权限、
装给整个系统，为了录段屏太重了。

Windows 自己有现成的接口：WASAPI 的**回环采集**（loopback）——
对着「输出设备」开一个采集流，读到的就是它正在播的那一路混音。
OBS 这些软件走的都是这条。用的人什么都不用装，插什么声卡都行。

# 没声音的时候要自己补静音

**这是最容易踩的一条。** 输出设备完全闲着时，回环采集根本不给数据 ——
不是给一堆零，是一帧都不给。照抄下来的话，「静音的那 10 秒」在音轨里根本不存在，
后面的声音会整体往前挪，音画越走越偏。

所以这里按**墙上时钟**对账：每一轮算一下「到现在为止该有多少帧」，
少了多少就补多少帧的零。
*/
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use wasapi::*;

/// 固定成这一档喂给 ffmpeg，省得两边商量格式。
/// autoconvert 打开之后由音频引擎负责转，设备本身是什么格式都不用管。
pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;
/// 32 位浮点 = ffmpeg 的 f32le
pub const BITS: usize = 32;
/// 一帧多少字节
const BLOCK: usize = (BITS / 8) * CHANNELS as usize;

/// 一次往管道里塞多少帧。太小了系统调用频繁，太大了延迟明显
const CHUNK_FRAMES: usize = 480; // 10ms

pub struct Handle {
    stop: Arc<AtomicBool>,
}

impl Handle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// 起一条线程抓声音，抓到的原始 PCM 从 `tx` 出去。
///
/// 返回的 Handle 一丢（或者调 stop）线程就收工。
pub fn start(tx: tokio::sync::mpsc::UnboundedSender<Vec<u8>>) -> Handle {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();

    std::thread::Builder::new()
        .name("xg-loopback".into())
        .spawn(move || {
            if let Err(e) = capture_loop(&flag, &tx) {
                eprintln!("[loopback] 抓声音失败，这段录像就没有声音了: {e}");
                // 失败也得让 ffmpeg 那头有东西读，不然它会一直等在管道上
                fill_silence_until_stopped(&flag, &tx);
            }
        })
        .expect("spawn loopback thread");

    Handle { stop }
}

fn capture_loop(
    stop: &AtomicBool,
    tx: &tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
) -> Result<(), Box<dyn std::error::Error>> {
    // COM 得在这条线程上自己初始化
    initialize_mta().ok()?;

    let enumerator = DeviceEnumerator::new()?;
    /*
        注意这里取的是 **Render**（输出设备），下面 initialize_client 又要 Capture ——
        「对着输出设备开采集」正是 loopback 的写法，库看到这个组合会自动带上
        AUDCLNT_STREAMFLAGS_LOOPBACK。取 Capture 设备的话抓到的是麦克风。
    */
    let device = enumerator.get_default_device(&Direction::Render)?;
    let mut client = device.get_iaudioclient()?;

    let fmt = WaveFormat::new(BITS, BITS, &SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);
    let (default_period, _min_period) = client.get_device_period()?;
    client.initialize_client(
        &fmt,
        &Direction::Capture,
        &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: default_period },
    )?;

    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;

    let mut queue: VecDeque<u8> = VecDeque::with_capacity(BLOCK * SAMPLE_RATE as usize);
    let started = Instant::now();
    let mut frames_sent: u64 = 0;

    while !stop.load(Ordering::Relaxed) {
        // 拿不到事件不算错：设备闲着的时候本来就不会响
        let _ = event.wait_for_event(200);

        /*
            **把攒着的包一次读干净**，别一轮只读一个。

            `read_from_device_to_deque` 一次只取一个包。设备那头的环形缓冲区就那么大，
            这一轮没取走的，下一轮不一定还在 —— 满了它直接盖掉，那段声音就没了。
            而丢掉的部分下面对账时会被当成「缺帧」补上静音：听起来就是**声音被剪掉一截**，
            接回来的地方还「啪」一下（用户报的爆音）。
        */
        while matches!(capture.get_next_packet_size(), Ok(Some(n)) if n > 0) {
            if capture.read_from_device_to_deque(&mut queue).is_err() {
                break;
            }
        }

        /*
            对账：到现在为止本来该有多少帧？少的那些补零。

            留 20ms 的余量，别把正常的抖动也当成缺帧去补 —— 补过头会让声音
            比画面慢一点点，而且越补越多。
        */
        let target = (started.elapsed().as_secs_f64() * SAMPLE_RATE as f64) as u64;
        let have = frames_sent + (queue.len() / BLOCK) as u64;
        let slack = (SAMPLE_RATE / 50) as u64; // 20ms
        if target > have + slack {
            let missing = (target - have - slack) as usize;
            queue.extend(std::iter::repeat(0u8).take(missing * BLOCK));
        }

        while queue.len() >= CHUNK_FRAMES * BLOCK {
            let chunk: Vec<u8> = queue.drain(..CHUNK_FRAMES * BLOCK).collect();
            frames_sent += CHUNK_FRAMES as u64;
            // 管道那头断了（ffmpeg 退了）就没必要再抓了
            if tx.send(chunk).is_err() {
                let _ = client.stop_stream();
                return Ok(());
            }
        }
    }

    let _ = client.stop_stream();
    Ok(())
}

/// 抓不到声音时的退路：照样按时间往管道里灌静音。
///
/// 直接不写的话 ffmpeg 会卡在读管道上，整段录像跟着一起完蛋 ——
/// 宁可出一条没声音的音轨，也不能把画面也搭进去。
fn fill_silence_until_stopped(stop: &AtomicBool, tx: &tokio::sync::mpsc::UnboundedSender<Vec<u8>>) {
    let started = Instant::now();
    let mut frames_sent: u64 = 0;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(10));
        let target = (started.elapsed().as_secs_f64() * SAMPLE_RATE as f64) as u64;
        while frames_sent + CHUNK_FRAMES as u64 <= target {
            if tx.send(vec![0u8; CHUNK_FRAMES * BLOCK]).is_err() {
                return;
            }
            frames_sent += CHUNK_FRAMES as u64;
        }
    }
}
