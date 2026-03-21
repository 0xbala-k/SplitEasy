import SwiftUI
import WebKit

// WKURLSchemeHandler intercepts spliteasy:// at the scheme level,
// catching both HTTP 302 redirects and JS-initiated navigation.
private final class SpliteasySchemeHandler: NSObject, WKURLSchemeHandler {
    let onCode: (String) -> Void
    let onCancel: () -> Void

    init(onCode: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.onCode = onCode
        self.onCancel = onCancel
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { onCancel(); return }
        print("🎯 Intercepted scheme: \(url.absoluteString)")
        // Provide a minimal response so WKWebView doesn't error
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(Data())
        urlSchemeTask.didFinish()
        if let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value {
            onCode(code)
        } else {
            onCancel()
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}

struct SplitwiseWebAuthView: UIViewRepresentable {
    let url: URL
    let onCode: (String) -> Void
    let onCancel: () -> Void

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(
            SpliteasySchemeHandler(onCode: onCode, onCancel: onCancel),
            forURLScheme: "spliteasy"
        )
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
