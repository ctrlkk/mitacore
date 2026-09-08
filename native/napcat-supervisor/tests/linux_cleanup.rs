#![cfg(target_os = "linux")]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WAIT_TIMEOUT: Duration = Duration::from_secs(8);

#[test]
fn cleans_detached_descendant_when_launcher_exits() {
    let pid_path = temporary_path("launcher-exit.pid");
    let lock_path = temporary_path("launcher-exit.lock");
    let script =
        r#"setsid /bin/sh -c 'trap "" TERM; exec sleep 60' >/dev/null 2>&1 & echo $! > "$1""#;
    let mut supervisor = start_supervisor(&lock_path, script, &pid_path);
    let detached_pid = wait_for_pid(&pid_path);

    let status = wait_for_exit(&mut supervisor);
    assert!(status.success(), "supervisor 退出状态异常: {status}");
    assert_process_gone(detached_pid);

    remove_files(&[pid_path, lock_path]);
}

#[test]
fn cleans_detached_descendant_when_stdin_closes() {
    let pid_path = temporary_path("stdin-close.pid");
    let lock_path = temporary_path("stdin-close.lock");
    let script =
        r#"setsid /bin/sh -c 'trap "" TERM; exec sleep 60' >/dev/null 2>&1 & echo $! > "$1"; wait"#;
    let mut supervisor = start_supervisor(&lock_path, script, &pid_path);
    let detached_pid = wait_for_pid(&pid_path);

    drop(supervisor.stdin.take());
    let status = wait_for_exit(&mut supervisor);
    assert!(!status.success(), "被终止的启动器不应返回成功状态");
    assert_process_gone(detached_pid);

    remove_files(&[pid_path, lock_path]);
}

#[test]
fn cleans_detached_descendant_on_sigint() {
    let pid_path = temporary_path("sigint.pid");
    let lock_path = temporary_path("sigint.lock");
    let script =
        r#"setsid /bin/sh -c 'trap "" TERM; exec sleep 60' >/dev/null 2>&1 & echo $! > "$1"; wait"#;
    let mut supervisor = start_supervisor(&lock_path, script, &pid_path);
    let detached_pid = wait_for_pid(&pid_path);

    unsafe { libc::kill(supervisor.id() as i32, libc::SIGINT) };
    let status = wait_for_exit(&mut supervisor);
    assert!(!status.success(), "被中断的启动器不应返回成功状态");
    assert_process_gone(detached_pid);

    remove_files(&[pid_path, lock_path]);
}

fn start_supervisor(lock_path: &Path, script: &str, pid_path: &Path) -> Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_napcat-supervisor"))
        .arg("--lock")
        .arg(lock_path)
        .arg("--")
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("napcat-supervisor-test")
        .arg(pid_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("无法启动 supervisor");

    let stderr = child.stderr.take().expect("无法读取 supervisor stderr");
    let mut reader = BufReader::new(stderr);
    let mut ready = String::new();
    reader
        .read_line(&mut ready)
        .expect("无法读取 supervisor 就绪状态");
    assert_eq!(ready.trim(), "NAPCAT_SUPERVISOR_READY");
    child
        .stdin
        .as_mut()
        .expect("supervisor stdin 不可用")
        .write_all(b"1")
        .expect("无法触发 supervisor 启动目标进程");
    child
}

fn wait_for_pid(path: &Path) -> i32 {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if let Ok(content) = fs::read_to_string(path)
            && let Ok(pid) = content.trim().parse()
        {
            return pid;
        }
        assert!(Instant::now() < deadline, "等待测试进程 PID 超时");
        thread::sleep(Duration::from_millis(25));
    }
}

fn wait_for_exit(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().expect("无法查询 supervisor 状态") {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("等待 supervisor 退出超时");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn assert_process_gone(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while process_exists(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(!process_exists(pid), "残留测试进程 PID: {pid}");
}

fn process_exists(pid: i32) -> bool {
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

fn temporary_path(name: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时间无效")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "napcat-supervisor-{}-{unique}-{name}",
        std::process::id()
    ))
}

fn remove_files(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}
