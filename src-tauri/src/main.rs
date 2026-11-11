#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_future::{AsyncStatus, IAsyncOperation};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as SmtcManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlayStatus,
};

/* ---------------- blocking helper for WinRT async ops ---------------- */
fn block_on<T: windows::core::RuntimeType>(op: IAsyncOperation<T>) -> windows::core::Result<T> {
    loop {
        match op.Status()? {
            AsyncStatus::Started => std::thread::sleep(Duration::from_millis(3)),
            _ => return op.GetResults(),
        }
    }
}

fn now_filetime_100ns() -> i64 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64;
    (secs + 11644473600) * 10_000_000
}

/* ---------------- state model ---------------- */
#[derive(Serialize, Clone)]
struct MediaState {
    title: String,
    artist: String,
    playing: bool,
    duration_ms: i64,
    position_ms: i64,
    art: Option<String>, // data url
}

#[derive(Serialize)]
struct State {
    battery_pct: i32, // -1 = no battery
    charging: bool,
    volume: f32, // -1 = unavailable
    muted: bool,
    brightness: i32, // -1 = unavailable
    media: Option<MediaState>,
}

/* ---------------- SMTC (media) ---------------- */
static MGR: Mutex<Option<SmtcManager>> = Mutex::new(None);
static ART_CACHE: Mutex<(String, Option<String>)> = Mutex::new((String::new(), None));

fn smtc_manager() -> Option<SmtcManager> {
    unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
    {
        let g = MGR.lock().ok()?;
        if g.is_some() {
            return g.clone();
        }
    }
    let op = SmtcManager::RequestAsync().ok()?;
    let mgr = block_on(op).ok()?;
    if let Ok(mut g) = MGR.lock() {
        *g = Some(mgr.clone());
    }
    Some(mgr)
}

fn read_media() -> Option<MediaState> {
    let mgr = smtc_manager()?;
    let session = mgr.GetCurrentSession().ok()?;

    let info = session.GetPlaybackInfo().ok()?;
    let playing = matches!(info.PlaybackStatus().ok()?, PlayStatus::Playing);
    let rate = info
        .PlaybackRate()
        .and_then(|r| r.Value())
        .unwrap_or(1.0);

    let tl = session.GetTimelineProperties().ok();
    let (mut pos100, dur100, updated100) = match &tl {
        Some(t) => (
            t.Position().map(|p| p.Duration).unwrap_or(0),
            t.EndTime().map(|p| p.Duration).unwrap_or(0),
            t.LastUpdatedTime().map(|p| p.UniversalTime).unwrap_or(0),
        ),
        None => (0, 0, 0),
    };
    if playing && updated100 > 0 {
        pos100 += ((now_filetime_100ns() - updated100) as f64 * rate) as i64;
    }
    if dur100 > 0 && pos100 > dur100 {
        pos100 = dur100;
    }

    let props = block_on(session.TryGetMediaPropertiesAsync().ok()?).ok()?;
    let title = props.Title().map(|h| h.to_string_lossy()).unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    let mut artist = props.Artist().map(|h| h.to_string_lossy()).unwrap_or_default();
    if artist.is_empty() {
        artist = props
            .AlbumArtist()
            .map(|h| h.to_string_lossy())
            .unwrap_or_default();
    }

    let key = format!("{}|{}", title, artist);
    let mut art: Option<String> = None;
    if let Ok(cache) = ART_CACHE.lock() {
        if cache.0 == key {
            art = cache.1.clone();
        }
    }
    if art.is_none() {
        art = read_art(&props);
        if let Ok(mut cache) = ART_CACHE.lock() {
            *cache = (key, art.clone());
        }
    }

    Some(MediaState {
        title,
        artist,
        playing,
        duration_ms: dur100 / 10_000,
        position_ms: pos100 / 10_000,
        art,
    })
}

fn read_art(
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    let thumb_ref = props.Thumbnail().ok()?;
    let thumb = thumb_ref;
    let stream = block_on(thumb.OpenReadAsync().ok()?).ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 400_000 {
        return None;
    }
    let reader = windows::Storage::Streams::DataReader::CreateDataReader(&stream).ok()?;
    block_on(reader.LoadAsync(size as u32).ok()?).ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Some(format!("data:image/jpeg;base64,{}", b64))
}

fn media_control(cmd: &str) {
    let Some(mgr) = smtc_manager() else { return };
    let Ok(session) = mgr.GetCurrentSession() else { return };
    let playing = session
        .GetPlaybackInfo()
        .and_then(|i| i.PlaybackStatus())
        .map(|s| matches!(s, PlayStatus::Playing))
        .unwrap_or(false);
    let op = match cmd {
        "next" => session.TrySkipNextAsync(),
        "prev" => session.TrySkipPreviousAsync(),
        _ => {
            if playing {
                session.TryPauseAsync()
            } else {
                session.TryPlayAsync()
            }
        }
    };
    if let Ok(op) = op {
        let _ = block_on(op);
    }
}

fn media_seek(ms: i64) {
    let Some(mgr) = smtc_manager() else { return };
    if let Ok(session) = mgr.GetCurrentSession() {
        if let Ok(op) = session.TryChangePlaybackPositionAsync(ms * 10_000) {
            let _ = block_on(op);
        }
    }
}

/* ---------------- volume (WASAPI) ---------------- */
use windows::Win32::Media::Audio::{
    eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
fn endpoint() -> Option<IAudioEndpointVolume> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
    }
}

fn get_volume() -> (f32, bool) {
    match endpoint() {
        Some(ep) => unsafe {
            let v = ep.GetMasterVolumeLevelScalar().unwrap_or(-1.0);
            let m = ep.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            (v, m)
        },
        None => (-1.0, false),
    }
}

fn set_volume(v: f32) {
    if let Some(ep) = endpoint() {
        unsafe {
            let _ = ep.SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0), std::ptr::null());
            if v > 0.001 {
                let _ = ep.SetMute(false, std::ptr::null());
            }
        }
    }
}

/* ---------------- battery (WinRT) ---------------- */
fn read_battery() -> (i32, bool) {
    use windows::Devices::Power::Battery;
    use windows::System::Power::BatteryStatus;
    let agg = match Battery::AggregateBattery() {
        Ok(b) => b,
        Err(_) => return (-1, false),
    };
    let rep = match agg.GetReport() {
        Ok(r) => r,
        Err(_) => return (-1, false),
    };
    let status = rep.Status().unwrap_or(BatteryStatus::NotPresent);
    if status == BatteryStatus::NotPresent {
        return (-1, false);
    }
    let rem = rep
        .RemainingCapacityInMilliwattHours()
        .and_then(|r| r.Value())
        .unwrap_or(-1);
    let full = rep
        .FullChargeCapacityInMilliwattHours()
        .and_then(|r| r.Value())
        .unwrap_or(-1);
    let pct = if rem >= 0 && full > 0 {
        (rem * 100 / full).clamp(0, 100)
    } else {
        -1
    };
    let charging = status == BatteryStatus::Charging || status == BatteryStatus::Idle;
    (pct, charging)
}

/* ---------------- brightness (WMI via powershell, cached) ---------------- */
static BRIGHT: std::sync::LazyLock<Mutex<(i32, Instant)>> = std::sync::LazyLock::new(|| Mutex::new((-1, Instant::now() - Duration::from_secs(10))));

fn ps(cmd: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", cmd])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn get_brightness() -> i32 {
    if let Ok(b) = BRIGHT.lock() {
        if b.1.elapsed() < Duration::from_secs(6) {
            return b.0;
        }
    }
    let v = ps("(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness).CurrentBrightness")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(-1);
    if let Ok(mut b) = BRIGHT.lock() {
        *b = (v, Instant::now());
    }
    v
}

fn set_brightness(v: i32) {
    let cmd = format!(
        "Invoke-CimMethod -InputObject (Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods) -MethodName WmiSetBrightness -Arguments @{{Timeout=1;Brightness={}}}",
        v.clamp(0, 100)
    );
    let _ = ps(&cmd);
    if let Ok(mut b) = BRIGHT.lock() {
        *b = (v.clamp(0, 100), Instant::now());
    }
}

/* ---------------- click-through: cursor watch thread ---------------- */
static ISLAND_RECT: Mutex<(f64, f64, f64, f64)> = Mutex::new((0.0, 0.0, 0.0, 0.0));

fn start_cursor_watch(win: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut interactive = false;
        loop {
            std::thread::sleep(Duration::from_millis(20));
            let mut pt = POINT { x: 0, y: 0 };
            unsafe {
                let _ = GetCursorPos(&mut pt);
            }
            let (rx, ry, rw, rh) = ISLAND_RECT.lock().map(|r| *r).unwrap_or((0.0, 0.0, 0.0, 0.0));
            let scale = win.scale_factor().unwrap_or(1.0);
            let wp = win.outer_position().unwrap_or_default();
            let x0 = wp.x as f64 + rx * scale;
            let y0 = wp.y as f64 + ry * scale;
            let inside = pt.x as f64 >= x0 - 6.0
                && pt.x as f64 <= x0 + rw * scale + 6.0
                && pt.y as f64 >= y0 - 6.0
                && pt.y as f64 <= y0 + rh * scale + 6.0;
            if inside != interactive {
                interactive = inside;
                let _ = win.set_ignore_cursor_events(!inside);
            }
        }
    });
}

/* Desktop-only Ctrl+I. Never reserve the chord while another app is foreground. */
static SHORTCUT_STATUS: Mutex<String> = Mutex::new(String::new());
fn start_desktop_shortcut(win: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetClassNameW, PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY};
        use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_CONTROL, MOD_NOREPEAT};
        let mut registered = false;
        loop {
            unsafe {
                let fg = GetForegroundWindow();
                let mut cls = [0u16; 128];
                let n = GetClassNameW(fg, &mut cls);
                let name = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
                let desktop = name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd";
                if desktop && !registered {
                    match RegisterHotKey(None, 71, MOD_CONTROL | MOD_NOREPEAT, 0x49) {
                        Ok(_) => { registered = true; if let Ok(mut s) = SHORTCUT_STATUS.lock() {*s = "Ready on the Windows desktop".into();} }
                        Err(_) => { if let Ok(mut s) = SHORTCUT_STATUS.lock() {*s = "Ctrl+I is unavailable: another app may own it".into();} }
                    }
                } else if !desktop && registered {
                    let _ = UnregisterHotKey(None, 71); registered = false;
                    if let Ok(mut s) = SHORTCUT_STATUS.lock() {*s = "Desktop only: switch to the Windows desktop to use Ctrl+I".into();}
                }
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    if msg.message == WM_HOTKEY && msg.wParam.0 == 71 {
                        if win.is_visible().unwrap_or(false) {let _ = win.hide();} else {let _ = win.show();}
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    });
}

#[tauri::command]
fn shortcut_status() -> String {
    SHORTCUT_STATUS.lock().map(|s| s.clone()).unwrap_or_default()
}
#[tauri::command]
fn hide_island(win: tauri::WebviewWindow) { let _ = win.hide(); }

/* ---------------- tauri commands ---------------- */
#[tauri::command]
async fn get_state() -> State {
    tauri::async_runtime::spawn_blocking(|| read_state()).await.expect("state worker")
}

fn read_state() -> State {
    unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
    let (battery_pct, charging) = read_battery();
    let (volume, muted) = get_volume();
    State {
        battery_pct,
        charging,
        volume,
        muted,
        brightness: get_brightness(),
        media: read_media(),
    }
}

#[tauri::command]
async fn media_cmd(cmd: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || media_control(&cmd)).await;
}

#[tauri::command]
async fn media_seek_ms(ms: i64) {
    let _ = tauri::async_runtime::spawn_blocking(move || media_seek(ms)).await;
}

#[tauri::command]
async fn volume_set(v: f32) {
    let _ = tauri::async_runtime::spawn_blocking(move || set_volume(v)).await;
}

#[tauri::command]
async fn brightness_set(v: i32) {
    let _ = tauri::async_runtime::spawn_blocking(move || set_brightness(v)).await;
}

#[tauri::command]
fn set_island_rect(x: f64, y: f64, w: f64, h: f64) {
    if let Ok(mut r) = ISLAND_RECT.lock() {
        *r = (x, y, w, h);
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    if std::env::args().any(|a| a == "--shortcut-probe") {
        use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_CONTROL, MOD_NOREPEAT};
        let result = unsafe {
            match RegisterHotKey(None, 71, MOD_CONTROL | MOD_NOREPEAT, 0x49) {
                Ok(_) => {let _ = UnregisterHotKey(None,71); "Ctrl+I registration succeeded".to_string()}
                Err(e) => format!("Ctrl+I registration failed: {e}"),
            }
        };
        let _ = std::fs::write("shortcut-probe.txt", result);
        return;
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_state,
            media_cmd,
            media_seek_ms,
            volume_set,
            brightness_set,
            set_island_rect,
            quit_app,
            hide_island,
            shortcut_status
        ])
        .setup(|app| {
            use tauri::Manager;
            let win = app.get_webview_window("main").unwrap();
            if let Ok(Some(mon)) = win.primary_monitor() {
                let size = mon.size();
                let pos = mon.position();
                let x = pos.x + (size.width as i32 - (920.0 * mon.scale_factor()) as i32) / 2;
                let _ = win.set_position(tauri::PhysicalPosition::new(x, pos.y));
            }
            let _ = win.set_ignore_cursor_events(true);
            start_cursor_watch(win.clone());
            start_desktop_shortcut(win.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running island");
}
