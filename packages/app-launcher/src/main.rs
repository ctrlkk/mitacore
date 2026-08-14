use std::env;
use std::io;
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};

fn main() -> ExitCode {
    configure_console();

    match run() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("启动应用失败：{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn configure_console() {
    // Node 以 UTF-8 写入标准流；旧版 Windows 控制台仍可能使用系统代码页。
    // 未附着控制台（例如由桌面端启动）时 API 会失败，此时无需处理。
    unsafe {
        SetConsoleCP(65001);
        SetConsoleOutputCP(65001);
    }
}

#[cfg(not(windows))]
fn configure_console() {}

#[cfg(windows)]
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn SetConsoleCP(code_page: u32) -> i32;
    fn SetConsoleOutputCP(code_page: u32) -> i32;
}

fn run() -> io::Result<u8> {
    let root = install_root()?;
    let node = root.join("bin").join(node_name());
    let entry = root.join("app.mjs");

    let status = Command::new(&node)
        .arg(&entry)
        .args(env::args_os().skip(1))
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;

    Ok(status.code().unwrap_or(1).clamp(0, u8::MAX as i32) as u8)
}

fn install_root() -> io::Result<PathBuf> {
    let launcher = env::current_exe()?;
    launcher
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other(format!("无法确定启动器目录：{}", launcher.display())))
}

#[cfg(windows)]
fn node_name() -> &'static str {
    "node.exe"
}

#[cfg(not(windows))]
fn node_name() -> &'static str {
    "node"
}
