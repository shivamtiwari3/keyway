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
            do {
                try p.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                out = String(data: data, encoding: .utf8) ?? ""
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
    @Published var connected = false
    @Published var provider = "Provider"
    @Published var detail = ""
    private var timer: Timer?
    init() {
        Task { await poll() }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            Task { @MainActor in await self.poll() }
        }
    }
    func poll() async {
        guard let url = URL(string: "http://127.0.0.1:8788/health") else { return }
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
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct MenuView: View {
    @EnvironmentObject var health: Health
    @Environment(\.openWindow) var openWindow

    var body: some View {
        Text(health.connected ? "● Connected — \(health.provider)" : "○ Not running")
        if health.connected && !health.detail.isEmpty {
            Text(health.detail).foregroundStyle(.secondary)
        }
        Divider()
        Button("Open Setup…") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
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
    @StateObject private var health = Health()

    var body: some Scene {
        Window("Keyway", id: "main") {
            ContentView().environmentObject(health)
        }
        .windowResizability(.contentSize)

        MenuBarExtra {
            MenuView().environmentObject(health)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: health.connected ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                Text(health.connected ? "Connected" : "Off")
            }
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
