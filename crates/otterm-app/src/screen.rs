//! Screen frames to the WebView over a local WebSocket (decision M2, docs/09-performance.md §3.3).
//!
//! Listens on 127.0.0.1 only. A client must present the per-launch token, which the WebView gets
//! through Tauri IPC, so other local processes and users cannot read the screen.

use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;

use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::{Bytes, Message};

/// Frames queued per client before it counts as stuck and is dropped. A redraw recovers it.
const CLIENT_QUEUE: usize = 256;

pub struct ScreenServer {
    port: u16,
    token: String,
    clients: Arc<Mutex<Vec<SyncSender<Bytes>>>>,
}

impl ScreenServer {
    pub fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let token = new_token()?;
        let clients: Arc<Mutex<Vec<SyncSender<Bytes>>>> = Arc::default();

        let accept_token = token.clone();
        let accept_clients = Arc::clone(&clients);
        thread::Builder::new().name("screen-accept".into()).spawn(move || {
            for stream in listener.incoming().flatten() {
                let token = accept_token.clone();
                let clients = Arc::clone(&accept_clients);
                let _ =
                    thread::Builder::new().name("screen-client".into()).spawn(move || serve(stream, &token, &clients));
            }
        })?;

        Ok(Self { port, token, clients })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Send a frame to every connected client.
    pub fn broadcast(&self, frame: Vec<u8>) {
        let frame = Bytes::from(frame);
        self.clients.lock().unwrap().retain(|tx| match tx.try_send(frame.clone()) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
        });
    }
}

/// Accept the WebSocket if the token matches, then pump frames to it until it goes away.
fn serve(stream: TcpStream, token: &str, clients: &Mutex<Vec<SyncSender<Bytes>>>) {
    if stream.set_nodelay(true).is_err() {
        return;
    }
    // The error type is tungstenite's callback signature, not ours to shrink.
    #[allow(clippy::result_large_err)]
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let query = req.uri().query().unwrap_or("");
        if query.split('&').any(|kv| kv == format!("token={token}")) {
            Ok(resp)
        } else {
            let mut deny = ErrorResponse::new(None);
            *deny.status_mut() = StatusCode::FORBIDDEN;
            Err(deny)
        }
    };
    let Ok(mut ws) = tungstenite::accept_hdr(stream, check) else { return };
    let (tx, rx) = mpsc::sync_channel(CLIENT_QUEUE);
    clients.lock().unwrap().push(tx);
    // The UI never sends anything that matters; reads would only block the writer, so only write.
    for frame in rx.iter() {
        if ws.send(Message::Binary(frame)).is_err() {
            break;
        }
    }
}

fn new_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
