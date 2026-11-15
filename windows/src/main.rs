use wry::application::event::{Event, WindowEvent};
use wry::application::event_loop::{ControlFlow, EventLoop};
use wry::application::window::WindowBuilder;
use wry::webview::WebViewBuilder;

fn main() {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Threebot")
        .with_inner_size(wry::application::dpi::LogicalSize::new(1024.0, 768.0))
        .build(&event_loop)
        .expect("create window");

    let url = std::env::var("THREEBOT_URL").unwrap_or_else(|_| "http://127.0.0.1:3780/".to_string());
    let _webview = WebViewBuilder::new(window)
        .with_url(&url)
        .build()
        .expect("create webview");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            *control_flow = ControlFlow::Exit;
        }
    });
}
