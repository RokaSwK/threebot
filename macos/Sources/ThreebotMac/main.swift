import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let gateway = URL(string: "http://127.0.0.1:3780/")!
    private var window: NSWindow!
    private var webView: WKWebView!
    private var popupViews: [ObjectIdentifier: WKWebView] = [:]
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var downloadDestinations: [ObjectIdentifier: (temporary: URL, chosen: URL)] = [:]
    private var userNavigation = false
    private var showingLoadError = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        createMenus()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // The Connect Apps popup must start from a user gesture.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Threebot"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.contentMinSize = NSSize(width: 360, height: 480)
        window.collectionBehavior = [.fullScreenPrimary]
        window.isReleasedWhenClosed = false
        window.contentView = webView
        if !window.setFrameUsingName("ThreebotMainWindow") {
            window.center()
        }
        window.setFrameAutosaveName("ThreebotMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: gateway))
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.deminiaturize(nil)
        window.makeKeyAndOrderFront(nil)
        return true
    }

    private func createMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Threebot", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Threebot", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Threebot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let edit = NSMenu(title: "Edit")
        for (title, selector, key) in [
            ("Undo", "undo:", "z"), ("Redo", "redo:", "Z"),
            ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
            ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")
        ] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        menu.addItem(editItem)

        let view = NSMenu(title: "View")
        for (title, action, key) in [
            ("Reload", #selector(reloadPage), "r"),
            ("Zoom In", #selector(zoomIn), "+"),
            ("Zoom Out", #selector(zoomOut), "-"),
            ("Actual Size", #selector(actualSize), "0")
        ] {
            let item = view.addItem(withTitle: title, action: action, keyEquivalent: key)
            item.target = self
        }
        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        viewItem.submenu = view
        menu.addItem(viewItem)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        let fullscreen = windowMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullscreen.keyEquivalentModifierMask = [.command, .control]
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }

    @objc private func reloadPage() {
        if webView.url == nil { webView.load(URLRequest(url: gateway)) }
        else { webView.reload() }
    }

    @objc private func zoomIn() { webView.pageZoom = min(2, webView.pageZoom + 0.1) }
    @objc private func zoomOut() { webView.pageZoom = max(0.5, webView.pageZoom - 0.1) }
    @objc private func actualSize() { webView.pageZoom = 1 }

    private func isSameOrigin(_ url: URL) -> Bool {
        url.scheme == gateway.scheme && url.host == gateway.host && url.port == gateway.port
    }

    private func isLocalBlob(_ url: URL) -> Bool {
        guard url.scheme == "blob", let inner = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return isSameOrigin(inner)
    }

    private func disposePopup(_ view: WKWebView) {
        guard popupViews.removeValue(forKey: ObjectIdentifier(view)) != nil else { return }
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let popup = popupViews[ObjectIdentifier(view)] != nil
        let topLevel = action.targetFrame?.isMainFrame ?? true
        let clicked = action.navigationType == .linkActivated || action.navigationType == .formSubmitted
        if !popup && topLevel && clicked { userNavigation = true }

        let blankPopup = url.absoluteString == "about:blank" && (popup || action.targetFrame == nil)
        let inlineDocument = !topLevel && ["about:blank", "about:srcdoc"].contains(url.absoluteString)
        if blankPopup || inlineDocument {
            decisionHandler(.allow)
        } else if isSameOrigin(url) || isLocalBlob(url) {
            // Same-site popup destinations reuse the visible app window.
            if (popup || action.targetFrame == nil) && !action.shouldPerformDownload {
                decisionHandler(.cancel)
                userNavigation = true
                webView.load(action.request)
                if popup { disposePopup(view) }
            } else {
                decisionHandler(action.shouldPerformDownload ? .download : .allow)
            }
        } else if topLevel && (popup || clicked || userNavigation) && ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
            if popup { disposePopup(view) }
            else { userNavigation = false }
        } else {
            decisionHandler(.cancel)
            if popup { disposePopup(view) }
        }
    }

    func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard action.targetFrame == nil, let url = action.request.url,
              url.absoluteString == "about:blank" else { return nil }
        let child = WKWebView(frame: .zero, configuration: configuration)
        child.navigationDelegate = self
        child.uiDelegate = self
        popupViews[ObjectIdentifier(child)] = child
        return child
    }

    func webViewDidClose(_ view: WKWebView) { disposePopup(view) }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        if view === webView { userNavigation = false }
    }

    func webView(_ view: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let url = response.response.url,
           !isSameOrigin(url), !isLocalBlob(url), url.absoluteString != "about:blank" {
            decisionHandler(.cancel)
            if userNavigation && ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
            userNavigation = false
            if view !== webView { disposePopup(view) }
            return
        }
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.lowercased().hasPrefix("attachment")
        decisionHandler(response.isForMainFrame && (!response.canShowMIMEType || attachment) ? .download : .allow)
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { handleLoadError(view, error) }
    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { handleLoadError(view, error) }

    private func handleLoadError(_ view: WKWebView, _ error: Error) {
        if view !== webView { disposePopup(view); return }
        userNavigation = false
        let failure = error as NSError
        guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled),
              !(failure.domain == "WebKitErrorDomain" && failure.code == 102), !showingLoadError else { return }
        showingLoadError = true
        let alert = NSAlert()
        alert.messageText = "Threebot could not load"
        alert.informativeText = "The local Threebot service must be running at http://127.0.0.1:3780/."
        alert.addButton(withTitle: "Retry")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] result in
            guard let self else { return }
            self.showingLoadError = false
            if result == .alertFirstButtonReturn { self.webView.load(URLRequest(url: self.gateway)) }
        }
    }

    func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    // The existing sidebar uses prompt() when creating a section.
    func webView(_ view: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard view === webView, frame.isMainFrame else { completionHandler(nil); return }
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { result in
            completionHandler(result == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    func webView(_ view: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { trackDownload(download) }
    func webView(_ view: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { trackDownload(download) }

    private func trackDownload(_ download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .OK, let chosen = panel.url else {
                completionHandler(nil)
                self?.downloads.removeValue(forKey: ObjectIdentifier(download))
                return
            }
            // WebKit needs a new file. Keep an existing destination intact until
            // the complete download can replace it after the user's Save choice.
            let temporary = chosen.deletingLastPathComponent().appendingPathComponent(".threebot-download-\(UUID().uuidString)")
            self.downloadDestinations[ObjectIdentifier(download)] = (temporary, chosen)
            completionHandler(temporary)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let id = ObjectIdentifier(download)
        downloads.removeValue(forKey: id)
        guard let destination = downloadDestinations.removeValue(forKey: id) else { return }
        do {
            if FileManager.default.fileExists(atPath: destination.chosen.path) {
                _ = try FileManager.default.replaceItemAt(destination.chosen, withItemAt: destination.temporary)
            } else {
                try FileManager.default.moveItem(at: destination.temporary, to: destination.chosen)
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Could not save download"
            alert.informativeText = "The complete download is at \(destination.temporary.path). \(error.localizedDescription)"
            alert.beginSheetModal(for: window)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let id = ObjectIdentifier(download)
        downloads.removeValue(forKey: id)
        if let destination = downloadDestinations.removeValue(forKey: id) {
            try? FileManager.default.removeItem(at: destination.temporary)
        }
        let failure = error as NSError
        guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled) else { return }
        let alert = NSAlert()
        alert.messageText = "Download failed"
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.setActivationPolicy(.regular)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
}
