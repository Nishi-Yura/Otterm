//! Cost of rewrapping on resize with a full scrollback (issue #2): a window drag resizes many
//! times a second, and each width change rewraps every line that wrapped or no longer fits.
//!
//!   cargo run --release -p otterm-vt --example reflow

use std::time::Instant;

fn main() {
    // Mostly short lines (a shell session), then a log where half the lines wrap.
    run("short lines", |i| 10 + (i * 37) % 70);
    run("long lines", |i| 40 + (i * 37) % 200);
}

fn run(name: &str, len_of: impl Fn(usize) -> usize) {
    let mut t = otterm_vt::Terminal::new(120, 40);
    for i in 0..10_040 {
        let len = len_of(i);
        let line: String = (0..len).map(|j| char::from(b'a' + ((i + j) % 26) as u8)).collect();
        t.advance(format!("\x1b[32m{i:05}\x1b[0m {line}\r\n").as_bytes());
    }
    let widths = [100, 80, 119, 60, 120, 90, 150, 120];
    let start = Instant::now();
    for &w in widths.iter().cycle().take(40) {
        t.resize(w, 40);
    }
    let per = start.elapsed().as_secs_f64() * 1000.0 / 40.0;
    println!("{name:<12} 10,000 lines of scrollback: {per:.2} ms per resize");
}
