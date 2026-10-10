//! Throughput of `Terminal::advance` by input shape, to find hot spots.
//!
//!   cargo run --release -p otterm-vt --example profile
//!
//! `vte-only` is the parser with an empty `Perform`: the ceiling for everything else.

use std::time::Instant;

const MIB: usize = 1024 * 1024;

fn rate(bytes: usize, start: Instant) -> f64 {
    bytes as f64 / MIB as f64 / start.elapsed().as_secs_f64()
}

fn terminal(name: &str, unit: &str) {
    let chunk = unit.repeat((64 * 1024 / unit.len()).max(1));
    let mut t = otterm_vt::Terminal::new(120, 40);
    let start = Instant::now();
    let mut fed = 0;
    while fed < 50 * MIB {
        t.advance(chunk.as_bytes());
        fed += chunk.len();
    }
    println!("{name:<15} {:>8.1} MiB/s", rate(fed, start));
}

fn parser_only() {
    struct Nop(u64);
    impl vte::Perform for Nop {
        fn print(&mut self, c: char) {
            self.0 = self.0.wrapping_add(c as u64);
        }
        fn execute(&mut self, b: u8) {
            self.0 = self.0.wrapping_add(b as u64);
        }
    }
    let chunk = format!("{}\r\n", "x".repeat(100)).repeat(600);
    let mut parser = vte::Parser::new();
    let mut nop = Nop(0);
    let start = Instant::now();
    let mut fed = 0;
    while fed < 200 * MIB {
        parser.advance(&mut nop, chunk.as_bytes());
        fed += chunk.len();
    }
    println!("{:<15} {:>8.1} MiB/s (checksum {})", "vte-only", rate(fed, start), nop.0 % 10);
}

fn main() {
    parser_only();
    terminal("lf-only", "\n");
    terminal("print-noscroll", &format!("{}\r", "x".repeat(100)));
    terminal("ascii-long", &format!("{}\r\n", "x".repeat(100)));
    terminal("ascii-short", "abc\r\n");
    terminal("sgr", "\x1b[31ma\x1b[0mb\x1b[1mc\x1b[0m\r\n");
    terminal("wrap", &"y".repeat(100));
    terminal("cjk", &format!("{}\r\n", "日本".repeat(25)));
}
