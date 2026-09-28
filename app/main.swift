import SwiftUI
import AppKit

struct Preset {
    let name: String
    let upstream: String
    let models: String
}

let PRESETS: [Preset] = [
    Preset(name: "Anthropic", upstream: "https://api.anthropic.com", models: "claude-sonnet-4-20250514"),
    Preset(name: "OpenAI", upstream: "https://api.openai.com/v1", models: "gpt-4o-mini"),
    Preset(name: "OpenRouter", upstream: "https://openrouter.ai/api/v1", models: "openai/gpt-4o-mini"),
    Preset(name: "Groq", upstream: "https://api.groq.com/openai/v1", models: "llama-3.3-70b-versatile"),
    Preset(name: "DeepSeek", upstream: "https://api.deepseek.com/anthropic", models: "deepseek-chat"),
    Preset(name: "Ollama (local)", upstream: "http://127.0.0.1:11434/v1", models: "llama3.2"),
    Preset(name: "Custom", upstream: "", models: ""),
]

@MainActor
final class Model: ObservableObject {
    @Published var providerName = "OpenAI"
    @Published var upstream = "https://api.openai.com/v1"
    @Published var modelsText = "gpt-4o-mini"
    @Published var apiKey = ""
    @Published var statusText = "Checking…"
    @Published var installed = false
    @Published var log = ""
    @Published var busy = false

    let nodeURL: URL
    let setupURL: URL

    init() {
        let res = Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")
        nodeURL = res.appendingPathComponent("node")
        setupURL = res.appendingPathComponent("setup.mjs")
    }

    func applyPreset() {
        if let p = PRESETS.first(where: { $0.name == providerName }), p.name != "Custom" {
            upstream = p.upstream; modelsText = p.models
        }
    }

    var canInstall: Bool { !busy && !apiKey.isEmpty && !upstream.isEmpty && !modelsText.isEmpty }

    func refresh() { exec(["status"], label: "status") }
    func install() {
        exec(["install",
              "--key", apiKey,
              "--provider-name", providerName,
              "--upstream", upstream,
              "--api", "auto",
              "--models", modelsText], label: "install")
    }
    func uninstall() { exec(["uninstall"], label: "uninstall") }

    func exec(_ args: [String], label: String) {
        busy = true
        let node = nodeURL, setup = setupURL
        Task.detached {
            let p = Process()
            p.executableURL = node
            p.arguments = [setup.path] + args
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            var out = ""
            let watchdog = DispatchWorkItem { if p.isRunning { p.terminate() } }
            do {
                try p.run()
                DispatchQueue.global().asyncAfter(deadline: .now() + 240, execute: watchdog)
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                watchdog.cancel()
                out = String(data: data, encoding: .utf8) ?? ""
                if p.terminationStatus != 0 && out.isEmpty { out = "error: exit code \(p.terminationStatus)" }
            } catch {
                out = "error: \(error.localizedDescription)"
            }
            let result = out
            await MainActor.run {
                if label != "status" { self.log = result.isEmpty ? "(no output)" : result }
                self.busy = false
                if label == "uninstall" {
                    self.statusText = "Not installed"; self.installed = false
                } else if label == "install" {
                    self.installed = true
                    self.statusText = result.contains("installed") ? "Installed · Claude Desktop restarting…" : "Install failed"
                    if result.contains("installed") { self.apiKey = "" }
                } else {
                    let ok = result.contains("not-installed") ? false : result.contains("installed")
                    self.installed = ok
                    self.statusText = ok ? "Installed" : "Not installed"
                }
            }
        }
    }
}

@MainActor
final class Health: ObservableObject {
    static let shared = Health()
    @Published var connected = false
    @Published var provider = "Provider"
    @Published var detail = ""
    @Published var updateAvailable: String?
    private var timer: Timer?
    init() {
        Task { await poll() }
        Task { await checkUpdate() }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            Task { @MainActor in await self.poll() }
        }
    }

    func checkUpdate() async {
        guard let url = URL(string: "https://api.github.com/repos/shivamtiwari3/keyway/releases/latest") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = obj["tag_name"] as? String else { return }
        let current = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0"
        if Self.isNewer(Self.version(tag), Self.version(current)) { updateAvailable = tag }
    }

    static func version(_ s: String) -> [Int] {
        s.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            .split(separator: ".").map { Int($0.prefix(while: { $0.isNumber })) ?? 0 }
    }

    static func isNewer(_ a: [Int], _ b: [Int]) -> Bool {
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }
    private var healthURL: URL {
        let cfg = ("~/Library/Application Support/Keyway/config.json" as NSString).expandingTildeInPath
        if let data = FileManager.default.contents(atPath: cfg),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let port = obj["port"] as? Int,
           let url = URL(string: "http://127.0.0.1:\(port)/health") {
            return url
        }
        return URL(string: "http://127.0.0.1:8788/health")!
    }

    func poll() async {
        let url = healthURL
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { connected = false; return }
            connected = true
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                provider = (obj["providerName"] as? String) ?? "Provider"
                let api = (obj["api"] as? String) ?? "?"
                let n = (obj["models"] as? [Any])?.count ?? 0
                detail = "\(api) · \(n) model\(n == 1 ? "" : "s")"
            }
        } catch {
            connected = false
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var setupWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // Launched by the login item (with --background): stay in the menu bar
        // only. A normal double-click opens the setup window.
        if !CommandLine.arguments.contains("--background") { showSetup() }
    }

    func showSetup() {
        if setupWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 600),
                             styleMask: [.titled, .closable, .miniaturizable],
                             backing: .buffered, defer: false)
            w.title = "Keyway Setup"
            w.contentViewController = NSHostingController(rootView: ContentView())
            w.isReleasedWhenClosed = false
            w.center()
            setupWindow = w
        }
        NSApp.activate(ignoringOtherApps: true)
        setupWindow?.makeKeyAndOrderFront(nil)
    }
}

struct MenuBarLabel: View {
    @ObservedObject var health = Health.shared
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: health.connected ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
            Text(health.connected ? "Connected" : "Off")
        }
    }
}

struct MenuView: View {
    @ObservedObject var health = Health.shared

    var body: some View {
        Text(health.connected ? "● Connected — \(health.provider)" : "○ Not running")
        if health.connected && !health.detail.isEmpty {
            Text(health.detail).foregroundStyle(.secondary)
        }
        if let v = health.updateAvailable {
            Button("Update available: \(v)") {
                if let url = URL(string: "https://github.com/shivamtiwari3/keyway/releases/latest") {
                    NSWorkspace.shared.open(url)
                }
            }
        }
        Divider()
        Button("Open Setup…") {
            (NSApp.delegate as? AppDelegate)?.showSetup()
        }
        Button("Copy Diagnostics") {
            let text = "Keyway\nconnected=\(health.connected)\nlog=~/Library/Application Support/Keyway/gateway.log"
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
        Divider()
        Button("Quit Keyway") { NSApp.terminate(nil) }
    }
}

@main
struct KeywayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuView()
        } label: {
            MenuBarLabel()
        }
    }
}

struct ContentView: View {
    @StateObject private var m = Model()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").font(.system(size: 26)).foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Keyway").font(.title).bold()
                    Text("Bring your own key — use any provider's models inside Claude Desktop.")
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 8) {
                Circle().fill(m.installed ? Color.green : Color.gray).frame(width: 10, height: 10)
                Text(m.statusText).font(.headline)
                Spacer()
                if m.busy { ProgressView().controlSize(.small) }
            }

            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
                GridRow {
                    Text("Provider").foregroundStyle(.secondary)
                    Picker("", selection: $m.providerName) {
                        ForEach(PRESETS, id: \.name) { Text($0.name).tag($0.name) }
                    }
                    .labelsHidden()
                    .onChange(of: m.providerName) { _ in m.applyPreset() }
                }
                GridRow {
                    Text("Endpoint").foregroundStyle(.secondary)
                    TextField("https://…", text: $m.upstream).textFieldStyle(.roundedBorder)
                        .onChange(of: m.upstream) { _ in
                            if let p = PRESETS.first(where: { $0.upstream == m.upstream }) { m.providerName = p.name }
                        }
                }
                GridRow {
                    Text("API key").foregroundStyle(.secondary)
                    SecureField("paste your key", text: $m.apiKey).textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text("Models").foregroundStyle(.secondary)
                    TextField("model-a, model-b", text: $m.modelsText).textFieldStyle(.roundedBorder)
                }
            }

            HStack(spacing: 10) {
                Button { m.install() } label: {
                    Label(m.installed ? "Update" : "Install", systemImage: "arrow.down.circle")
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!m.canInstall)

                Button(role: .destructive) { m.uninstall() } label: {
                    Label("Remove", systemImage: "trash")
                }
                .disabled(m.busy || !m.installed)

                Spacer()
                Button { m.refresh() } label: { Image(systemName: "arrow.clockwise") }.disabled(m.busy)
            }

            if !m.log.isEmpty {
                ScrollView {
                    Text(m.log).font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 110)
                .padding(8)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            }
        }
        .padding(22)
        .frame(width: 560)
        .onAppear { m.refresh() }
    }
}
