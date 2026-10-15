import SwiftUI
import RealityKit

struct ARViewContainer: UIViewRepresentable {
    let session: ScanSession

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero)
        session.attach(view)
        return view
    }

    func updateUIView(_ uiView: ARView, context: Context) {}
}

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

struct ContentView: View {
    @StateObject private var session = ScanSession()
    @State private var exportURL: URL?
    @State private var format = "usdz"
    @State private var errorText: String?

    private let formats = ["usdz", "obj", "ply", "stl"]

    var body: some View {
        ZStack(alignment: .bottom) {
            ARViewContainer(session: session).ignoresSafeArea()

            VStack(spacing: 12) {
                Text(session.statusMessage).font(.footnote)
                Text("\(session.triangleCount) triangles").font(.caption.monospacedDigit())

                Picker("Format", selection: $format) {
                    ForEach(formats, id: \.self) { Text($0.uppercased()).tag($0) }
                }
                .pickerStyle(.segmented)

                HStack(spacing: 16) {
                    Button(session.isScanning ? "Stop" : "Start") {
                        session.isScanning ? session.stop() : session.start()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!session.supportsLiDAR)

                    Button("Export") { export() }
                        .buttonStyle(.bordered)
                        .disabled(session.isScanning || session.triangleCount == 0)
                }
            }
            .padding()
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
            .padding()
        }
        .sheet(item: Binding(get: { exportURL.map(IdentifiableURL.init) },
                             set: { exportURL = $0?.url })) { ShareSheet(url: $0.url) }
        .alert("Export failed", isPresented: Binding(get: { errorText != nil },
                                                     set: { if !$0 { errorText = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(errorText ?? "") }
    }

    private func export() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("scan.\(format)")
        do {
            try MeshExporter.export(anchors: session.meshAnchors, to: url)
            exportURL = url
        } catch {
            errorText = error.localizedDescription
        }
    }
}

private struct IdentifiableURL: Identifiable {
    let url: URL
    var id: URL { url }
}
