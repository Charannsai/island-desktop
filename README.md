# Island

A floating Windows control surface. Rust handles system integration, and a Tauri webview renders a spring-animated island.

## Controls

- Music metadata and album art from Windows Global System Media Transport Controls
- Play/pause, previous, next and position seeking for compatible players
- System volume through WASAPI
- Built-in display brightness through WMI when supported
- Battery percentage and a charging banner
- Click-through outside the island, always on top
- Click the pill to expand. Click empty space inside it to collapse. Quit is inside the expanded island.

## Requirements

Windows 10/11 x64 and Microsoft Edge WebView2 Runtime. Players must publish a Windows media session. Brightness is only available when the display exposes WMI brightness controls. The portable executable is unsigned.

## Build

Install the stable Rust toolchain and Visual Studio C++ build tools, then:

```
cd src-tauri
cargo build --release --locked
```

Output: `src-tauri/target/release/island.exe`.

The manually triggered GitHub Actions workflow builds this portable executable on `windows-latest` and retains its artifact for seven days. It has a 20-minute timeout and read-only repository permissions.

## Verification and limits

The Windows API core has passed a cross-target type check. A full build and on-Windows runtime testing are separate checks. A browser preview uses sample data and cannot verify Windows controls. Notifications, automatic startup, global shortcuts, multi-monitor configuration and a tray menu are not implemented in this build. There is no network API or analytics in the application code. Brightness queries use a hidden local PowerShell process.

## UI preview

Open `ui/index.html?capture=1` in a browser for the labelled sample-data capture mode. This is not a substitute for testing on Windows.
