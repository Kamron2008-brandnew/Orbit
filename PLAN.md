# 3D Scanner App: Full Project Plan

## 1. Vision

A mobile app that turns real objects and people into 3D models that are ready to use immediately. The app handles capture, cloud processing, cleanup, and export, so users never touch a mesh editor.

**Core promise:** Scan, auto-clean, export in a ready-to-use format.

**Target users:**
- Game developers who need characters and props
- Indie creators and 3D artists
- Makers who 3D print
- Everyday users who want AR or shareable models

---

## 2. Product Scope

### Phase 1: Objects (MVP)
- Guided capture with live coverage preview
- Auto-scaling to real-world size
- Cleaned, textured mesh
- Export: GLB, USDZ, STL, OBJ

### Phase 2: Faces
- TrueDepth capture on iPhone
- Fit to a template head mesh for clean topology
- Blendshape rigging (FACS-based)
- Export: FBX, GLB with Unreal and Unity presets

### Phase 3: Full Body and Polish
- Fast full-body capture (30 seconds or less)
- Auto-rigging with a standard skeleton
- Stylized output options
- Direct send to Unreal, Unity, and Blender

---

## 3. Capture Layer

| Method | Best for | Platform |
|---|---|---|
| LiDAR + ARKit scene reconstruction | Rooms, large objects, scale | iPhone Pro, iPad Pro |
| Photogrammetry (50 to 100 photos or video) | Small objects, texture detail | Any phone |
| TrueDepth camera | Faces | iPhone with Face ID |
| Video for Gaussian Splatting or NeRF | Visually rich scenes | Any phone |

**Capture UX requirements:**
- Live coverage indicator so users know when they have enough angles
- Lighting and motion-blur warnings
- Audio guidance for face scans (user cannot see the screen)
- Reject or flag bad captures before upload

---

## 4. Processing Pipeline

1. **Upload** images, video, and depth data
2. **Reconstruct** using photogrammetry or Gaussian Splatting
3. **Extract mesh** from the reconstruction
4. **Clean up:** background removal, hole filling, decimation, noise removal
5. **Retopologize** for game-ready edge flow (faces especially)
6. **Bake textures:** albedo (lighting removed), normal, roughness, displacement
7. **Rig** (Phase 2 and 3): blendshapes and skeleton
8. **Export** in multiple formats and quality levels

**Speed target:** A rough preview in under 1 minute, then a refined result in the background.

---

## 5. Free and Open Source Tool Stack

### Capture
- **iOS:** Xcode, ARKit, RealityKit (free; $99/year only for App Store publishing)
- **Android:** Android Studio, ARCore (free; $25 one-time for Google Play)
- **Face landmarks:** MediaPipe Face Mesh

### Processing
- **Photogrammetry:** COLMAP, Meshroom (AliceVision), OpenMVS
- **Gaussian Splatting and NeRF:** Nerfstudio, gsplat
- **Mesh processing:** Blender (Python scripting), Open3D, MeshLab, trimesh
- **Retopology:** Instant Meshes
- **Export:** Blender and trimesh for GLB, FBX, STL; Apple tools or Blender for USDZ

### Zero-cost shortcut
Apple's Object Capture API runs on-device or on a Mac for free. An iOS-first objects version can skip cloud processing entirely.

### Development compute
- Google Colab and Kaggle free GPU tiers for building and testing
- Not suitable for serving real users

### Backend (early stage free tiers)
- Cloudflare, Supabase, or Firebase for storage, auth, and queues

---

## 6. License Watch List

| Tool | Concern |
|---|---|
| Original Gaussian Splatting code | Non-commercial license |
| Instant-NGP | Non-commercial license |
| FLAME head model | Non-commercial license |
| COLMAP, Blender, Open3D, Nerfstudio | Generally permissive, verify each version |

**Action:** Audit every dependency before any paid launch. Plan commercial-safe alternatives (for example a custom head template instead of FLAME).

---

## 7. Architecture Overview

```
Phone App (capture + preview)
        |
        v
Upload API (auth, storage)
        |
        v
Job Queue
        |
        v
GPU Workers (reconstruct, mesh, clean, bake, rig)
        |
        v
Asset Storage (GLB, USDZ, FBX, STL)
        |
        v
App (view, AR preview, share, export to engine)
```

---

## 8. Objects vs. People

**Objects**
- Auto-scale using LiDAR or ARKit measurements
- Produce both a low-poly optimized version and a high-detail version

**People**
- Subjects move, so capture must be fast
- Face: TrueDepth scan fit to a template mesh for automatic clean topology
- Body: standard skeleton auto-rig
- Consent flow required before any capture

---

## 9. Legal and Privacy

Face scans are biometric data.

- Explicit, informed consent before capture (BIPA in Illinois, GDPR in the EU, and similar laws)
- Clear data retention and deletion policy
- Encrypted storage and strict access control
- User can delete scans and derived models at any time
- No use of scans for model training without separate opt-in consent
- Privacy policy and terms written before the face feature ships

---

## 10. Competition and Differentiation

**Existing players:** Polycam, Scaniverse, Luma, RealityScan, Epic MetaHuman

**Differentiation options (pick one to lead with):**
- One-tap path from phone scan to rigged, engine-ready character
- Strong game-developer workflow with Unreal and Unity presets
- Stylized as well as realistic output
- A niche use case: 3D printing, sports gear fitting, education, archaeology

---

## 11. Costs and Monetization

**Costs**
- Development: near $0 with free tools
- Publishing: $99/year (Apple), $25 one-time (Google)
- GPU processing: roughly $0.10 to $1+ per scan at scale
- Storage and bandwidth grow with usage

**Monetization ideas**
- Free tier with limited scans per month and watermarked or low-res export
- Credits for high-detail and rigged exports
- Pro subscription for game developers (higher quality, batch processing, engine plugins)

---

## 12. Roadmap

| Stage | Goal | Deliverable |
|---|---|---|
| 1 | Prototype | ARKit LiDAR live mesh on screen, USDZ/OBJ export |
| 2 | Objects MVP | Apple Object Capture or COLMAP pipeline, auto-clean, GLB/USDZ/STL export |
| 3 | Cloud pipeline | Job queue, GPU workers, preview-then-refine flow |
| 4 | Beta | Test with 20 to 50 users, collect failed-capture data |
| 5 | Face feature | TrueDepth capture, template fitting, blendshape rig, consent flow |
| 6 | Game integration | FBX export, Unreal and Unity presets, plugins |
| 7 | Full body | Fast body capture, auto-rig |
| 8 | Launch | Pricing, license audit, App Store release |

---

## 13. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| GPU costs at scale | Credits, on-device processing where possible, efficient pipelines |
| Poor captures (shiny, transparent, textureless surfaces) | Capture guidance, quality checks, clear failure messages |
| Unreliable auto-rigging | Start with face blendshapes on a fixed template, expand gradually |
| Non-commercial licenses | Early audit, swap in permissive alternatives |
| Biometric privacy liability | Consent flows, minimal retention, legal review before launch |
| Crowded market | Focus on one differentiator and one user group |

---

## 14. Success Metrics

- Scan success rate (usable result on first attempt)
- Time to first preview
- Processing cost per scan
- Export-to-engine completion rate
- Weekly active scanners and retention
- Share of scans exported to a game engine or 3D printer

---

## 15. Immediate Next Steps

1. Build the ARKit LiDAR prototype and export a USDZ
2. Test Apple Object Capture on 10 different objects to learn its limits
3. Set up a COLMAP and Blender cleanup script on Colab
4. Decide the lead differentiator and target user
5. Draft the license audit spreadsheet
