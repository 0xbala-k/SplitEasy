import SwiftUI
import WebKit

// WKWebView-based OAuth presenter. ASWebAuthenticationSession cannot reliably
// intercept Splitwise's mobile redirect (goes through an intermediate page).
// WKWebView's navigation delegate catches the spliteasy:// scheme directly.
struct SplitwiseWebAuthView: UIViewRepresentable {
    let url: URL
    let onCode: (String) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode, onCancel: onCancel)
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let onCode: (String) -> Void
        let onCancel: () -> Void

        init(onCode: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
            self.onCode = onCode
            self.onCancel = onCancel
        }

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            print("🌐 WKWebView navigating to: \(url.absoluteString)")
            if url.scheme == "spliteasy" {
                decisionHandler(.cancel)
                if let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "code" })?.value {
                    onCode(code)
                } else {
                    onCancel()
                }
                return
            }
            decisionHandler(.allow)
        }
    }
}
