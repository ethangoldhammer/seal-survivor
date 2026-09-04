//  ---------------------------------------------------------------------------
//  TELLING THE PAGE IT WAS KILLED, RATHER THAN LETTING IT GUESS.
//
//  The reset players see on this phone is not a crash in the game. iOS kills
//  WKWebView's WebContent process at its per-process memory limit — verified on
//  device, `memorystatus: com.apple.WebKit.WebContent exceeded mem limit:
//  ActiveHard 2048 MB (fatal)` — and Capacitor's WebViewDelegationHandler does
//  the only sensible thing it can:
//
//      open func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
//          bridge?.reset()
//          webView.reload()
//      }
//
//  The app never dies. The page is reloaded under it, and the JavaScript that
//  comes back has no idea anything happened. path/src/systems/crashLog.js
//  reconstructs it from breadcrumbs — a record left open means the process went
//  away underneath it — and that inference is good, but it is an inference: it
//  cannot tell a memory kill from a tab that was reclaimed, from a hard refresh
//  on a desktop, and it cannot count them across launches because each launch
//  only ever sees the one session before it.
//
//  This is the fact instead of the inference. It is worth being clear about
//  what that does and does not buy:
//
//    IT DOES NOT PREVENT THE KILL. Nothing here can. The limit belongs to the
//    kernel and to a process this app does not own, and no Capacitor or
//    WKWebView setting moves it.
//
//    IT DOES let the page know for certain, on the first line of JavaScript it
//    runs, that it is coming back from one — which is what decides whether the
//    run in path/src/systems/runSnapshot.js is handed back or dropped — and it
//    keeps a lifetime count, which is the number that says whether a change to
//    the game made any difference at all.
//
//  WHY A FORWARDING PROXY. `WebViewDelegationHandler` is `open` and the method
//  is `open`, so it is overridable — but `CAPBridgeViewController.loadView()`
//  is `public final` and constructs the handler itself, so there is no seam to
//  hand it a subclass through. What there IS is `capacitorDidLoad()`, which
//  runs with the web view built and its navigationDelegate already assigned. So
//  the delegate is wrapped rather than replaced: this object implements the one
//  method it cares about and forwards every other selector to Capacitor's
//  handler untouched, via NSObject's own message forwarding. Capacitor keeps
//  all of its behaviour including the reload — this only gets to write one line
//  down on the way past.
//
//  WHY NOT didReceiveMemoryWarning, which is the obvious thing to reach for on
//  a view controller: it is delivered to THIS process, and the process being
//  killed is a different one. The app's own footprint is small and healthy at
//  the moment WebContent dies. A warning here would be a warning about the
//  wrong thing, arriving too late to matter.
//  ---------------------------------------------------------------------------

import UIKit
import WebKit
import Capacitor

/// Where the count lives between launches. UserDefaults and not a file: it is
/// two numbers, it has to survive an app relaunch, and it must be writable from
/// inside a delegate callback that is already halfway through a teardown.
private enum KillRecord {
    static let countKey = "sealSurvivor.webContentKills"
    static let lastKey = "sealSurvivor.webContentKillAt"

    /// Returns the new total.
    @discardableResult
    static func record() -> Int {
        let defaults = UserDefaults.standard
        let next = defaults.integer(forKey: countKey) + 1
        defaults.set(next, forKey: countKey)
        defaults.set(Date().timeIntervalSince1970, forKey: lastKey)
        return next
    }

    static var count: Int { UserDefaults.standard.integer(forKey: countKey) }
    static var lastAt: TimeInterval { UserDefaults.standard.double(forKey: lastKey) }
}

/// Wraps Capacitor's navigation delegate. Everything it does not implement
/// itself is forwarded, so from WebKit's side this is the handler.
private final class WebContentKillWatcher: NSObject, WKNavigationDelegate {
    /// Strong on purpose. `WKWebView.navigationDelegate` is weak and the bridge
    /// is the only other owner; a proxy that held this weakly would work right
    /// up until the day the bridge stopped keeping it.
    private let inner: NSObject
    private weak var host: GameBridgeViewController?

    init(wrapping inner: NSObject, host: GameBridgeViewController) {
        self.inner = inner
        self.host = host
    }

    // The whole of the forwarding. WKNavigationDelegate is an @objc protocol
    // and WebKit asks `respondsToSelector` before every optional call, so these
    // two overrides are enough to be indistinguishable from the handler for
    // every method not defined above.
    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner.responds(to: aSelector) ? inner : super.forwardingTarget(for: aSelector)
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || inner.responds(to: aSelector)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let total = KillRecord.record()
        NSLog("⚡️ WebContent process was killed (%d this install) — reloading", total)
        // The stamp for the page that is about to be loaded, injected BEFORE
        // Capacitor's reload rather than after it: a script added to the content
        // controller only applies to documents that start after it is added, so
        // one added a moment too late would miss the very load it describes.
        host?.installKillStamp()
        // ...and then Capacitor's own handling, unchanged. bridge.reset() and
        // the reload are its business and this file has no opinion about them.
        (inner as? WKNavigationDelegate)?.webViewWebContentProcessDidTerminate?(webView)
    }
}

class GameBridgeViewController: CAPBridgeViewController {
    private var killWatcher: WebContentKillWatcher?
    private var killStamp: WKUserScript?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView, let inner = webView.navigationDelegate as? NSObject else { return }
        let watcher = WebContentKillWatcher(wrapping: inner, host: self)
        killWatcher = watcher            // the delegate reference below is weak
        webView.navigationDelegate = watcher
        // For a cold launch. The reload after a kill does not come back through
        // here — the app process never restarted — so the stamp is installed in
        // both places and each covers what the other cannot.
        installKillStamp()
    }

    /// Put the current record in front of the next document that loads.
    ///
    /// AT DOCUMENT START and in the main world, because the page reads it in the
    /// first lines of main.js to decide whether to hand the interrupted run
    /// back. A value that arrived after the module graph had evaluated would be
    /// a value that arrived after the decision.
    fileprivate func installKillStamp() {
        guard let controller = webView?.configuration.userContentController else { return }
        // Removing all user scripts and re-adding is the only API there is —
        // WKUserContentController has no remove-one. Capacitor adds its own
        // bridge scripts through this same controller, so tearing the list down
        // would take those with it. Instead the stamp is only ever added, and
        // it is added at most twice per launch (once here, once per kill),
        // which is a handful of small scripts over the life of a process.
        // The newest is added last and therefore runs last, so it wins.
        let source = """
        window.__sealNativeKill = {
          count: \(KillRecord.count),
          at: \(KillRecord.lastAt),
          shell: 'ios'
        };
        """
        let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        killStamp = script
        controller.addUserScript(script)
    }
}
