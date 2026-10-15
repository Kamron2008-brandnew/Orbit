import ARKit
import ModelIO
import MetalKit

enum MeshExportError: LocalizedError {
    case noMesh
    case noMetal
    case unsupportedFormat(String)

    var errorDescription: String? {
        switch self {
        case .noMesh: return "Nothing has been scanned yet."
        case .noMetal: return "Metal is unavailable on this device."
        case .unsupportedFormat(let ext): return "Export to .\(ext) is not supported by ModelIO on this OS."
        }
    }
}

/// Converts ARKit mesh anchors into a ModelIO asset (world-space, meters, Y-up) and writes it to disk.
enum MeshExporter {
    static func export(anchors: [ARMeshAnchor], to url: URL) throws {
        guard !anchors.isEmpty else { throw MeshExportError.noMesh }
        guard let device = MTLCreateSystemDefaultDevice() else { throw MeshExportError.noMetal }

        let ext = url.pathExtension.lowercased()
        guard MDLAsset.canExportFileExtension(ext) else { throw MeshExportError.unsupportedFormat(ext) }

        let allocator = MTKMeshBufferAllocator(device: device)
        let asset = MDLAsset(bufferAllocator: allocator)
        for anchor in anchors {
            asset.add(makeMesh(from: anchor, allocator: allocator))
        }
        try? FileManager.default.removeItem(at: url)
        try asset.export(to: url)
    }

    private static func makeMesh(from anchor: ARMeshAnchor, allocator: MDLMeshBufferAllocator) -> MDLMesh {
        let geometry = anchor.geometry
        let vertexCount = geometry.vertices.count

        // Vertices: transform from anchor-local into world space.
        var positions = [Float](repeating: 0, count: vertexCount * 3)
        let src = geometry.vertices
        for i in 0..<vertexCount {
            let ptr = src.buffer.contents().advanced(by: src.offset + src.stride * i)
            let v = ptr.assumingMemoryBound(to: Float.self)
            let world = anchor.transform * SIMD4<Float>(v[0], v[1], v[2], 1)
            positions[i * 3] = world.x
            positions[i * 3 + 1] = world.y
            positions[i * 3 + 2] = world.z
        }
        let vertexBuffer = allocator.newBuffer(with: positions.withUnsafeBufferPointer { Data(buffer: $0) },
                                               type: .vertex)

        // Faces: normalize to UInt32 indices regardless of ARKit's bytesPerIndex.
        let faces = geometry.faces
        let indexCount = faces.count * faces.indexCountPerPrimitive
        var indices = [UInt32](repeating: 0, count: indexCount)
        let base = faces.buffer.contents()
        for i in 0..<indexCount {
            let p = base.advanced(by: i * faces.bytesPerIndex)
            indices[i] = faces.bytesPerIndex == 2
                ? UInt32(p.assumingMemoryBound(to: UInt16.self).pointee)
                : p.assumingMemoryBound(to: UInt32.self).pointee
        }
        let indexBuffer = allocator.newBuffer(with: indices.withUnsafeBufferPointer { Data(buffer: $0) },
                                              type: .index)
        let submesh = MDLSubmesh(indexBuffer: indexBuffer,
                                 indexCount: indexCount,
                                 indexType: .uInt32,
                                 geometryType: .triangles,
                                 material: nil)

        let descriptor = MDLVertexDescriptor()
        descriptor.attributes[0] = MDLVertexAttribute(name: MDLVertexAttributePosition,
                                                      format: .float3,
                                                      offset: 0,
                                                      bufferIndex: 0)
        descriptor.layouts[0] = MDLVertexBufferLayout(stride: MemoryLayout<Float>.stride * 3)

        let mesh = MDLMesh(vertexBuffer: vertexBuffer,
                           vertexCount: vertexCount,
                           descriptor: descriptor,
                           submeshes: [submesh])
        mesh.addNormals(withAttributeNamed: MDLVertexAttributeNormal, creaseThreshold: 0.5)
        return mesh
    }
}
