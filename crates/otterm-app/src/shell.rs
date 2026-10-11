//! Shell integration loaded through the shell's start arguments (decision B6: no user file is
//! changed). PowerShell only for now, and only the working directory (OSC 7); the rest is M2.

const PWSH_SCRIPT: &str = include_str!("shell/otterm.ps1");

/// Arguments that start `program` with otterm's integration, or none when there is none for it.
pub fn integration_args(program: &str) -> Vec<String> {
    let stem =
        std::path::Path::new(program).file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if stem != "pwsh" && stem != "powershell" {
        return Vec::new();
    }
    // The script goes inline (-EncodedCommand: base64 of UTF-16LE). Dot-sourcing a file would be
    // refused under the default execution policy of Windows PowerShell 5.1 (Restricted), and
    // otterm should not loosen the user's policy. -NoExit keeps the shell open; the profile still
    // loads first, so the script wraps the prompt the profile set up.
    vec!["-NoLogo".into(), "-NoExit".into(), "-EncodedCommand".into(), encode_command(PWSH_SCRIPT)]
}

/// PowerShell's -EncodedCommand form.
fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
