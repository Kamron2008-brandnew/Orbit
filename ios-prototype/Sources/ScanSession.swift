import ARKit
import RealityKit
import Combine

/// Owns the AR session and the live LiDAR mesh.
final class ScanSession: NSObject, ObservableObject, ARSessionDelegate {
    @Published var isScanning = false
    @Published var triangleCount = 0
    @Published var statusMessage = "LiDAR check pending"

    let supportsLiDAR = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    private(set) weak var arView: ARView?
    private var anchors: [UUID: ARMeshAnchor] = [:]

    func attach(_ view: ARView) {
        arView = view
        view.session.delegate = self
        view.debugOptions = [.showSceneUnderstanding]
        view.environment.sceneUnderstanding.options = [.occlusion]
        statusMessage = supportsLiDAR ? "Ready to scan" : "This device has no LiDAR scanner"
    }

    func start() {
        guard supportsLiDAR, let view = arView else { return }
        let config = ARWorldTrackingConfiguration()
        config.sceneReconstruction = .mesh
        config.environmentTexturing = .none
        anchors.removeAll()
        view.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        isScanning = true
        statusMessage = "Scanning: move slowly around the object"
    }

    func stop() {
        arView?.session.pause()
        isScanning = false
        statusMessage = "Stopped: \(triangleCount) triangles captured"
    }

    var meshAnchors: [ARMeshAnchor] { Array(anchors.values) }

    // MARK: ARSessionDelegate

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { update(anchors) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { update(anchors) }
    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        for a in anchors { self.anchors[a.identifier] = nil }
        publishCount()
    }

    private func update(_ updated: [ARAnchor]) {
        for case let mesh as ARMeshAnchor in updated { anchors[mesh.identifier] = mesh }
        publishCount()
    }

    private func publishCount() {
        let total = anchors.values.reduce(0) { $0 + $1.geometry.faces.count }
        DispatchQueue.main.async { self.triangleCount = total }
    }
}
