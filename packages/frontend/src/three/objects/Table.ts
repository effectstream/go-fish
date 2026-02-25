import * as THREE from 'three';

/**
 * Green felt card table centered at the origin.
 */
export class Table {
  readonly mesh: THREE.Group;
  private feltMesh: THREE.Mesh;
  private edgeMesh: THREE.Mesh;

  constructor() {
    this.mesh = new THREE.Group();

    // Table dimensions
    const width = 16;
    const depth = 10;
    const height = 0.3;
    const edgeWidth = 0.4;
    const edgeHeight = 0.15;

    // Felt surface — dark green with subtle roughness
    const feltGeometry = new THREE.BoxGeometry(width, height, depth);
    const feltMaterial = new THREE.MeshStandardMaterial({
      color: 0x1b5e20,
      roughness: 0.85,
      metalness: 0.0,
    });
    this.feltMesh = new THREE.Mesh(feltGeometry, feltMaterial);
    this.feltMesh.position.y = -height / 2;
    this.feltMesh.receiveShadow = true;
    this.mesh.add(this.feltMesh);

    // Wooden edge rail — darker, slightly glossy
    const edgeMaterial = new THREE.MeshStandardMaterial({
      color: 0x3e2723,
      roughness: 0.4,
      metalness: 0.1,
    });

    // Create edge pieces (top, bottom, left, right)
    const edges: [number, number, number, number][] = [
      // [width, height, depth, z-position] for top/bottom
      [width + edgeWidth * 2, edgeHeight, edgeWidth, -(depth / 2 + edgeWidth / 2)],
      [width + edgeWidth * 2, edgeHeight, edgeWidth, depth / 2 + edgeWidth / 2],
      // [width, height, depth, x-position] for left/right — handled separately
    ];

    // Top and bottom edges
    for (const [w, h, d, z] of edges) {
      const geo = new THREE.BoxGeometry(w, h, d);
      const edge = new THREE.Mesh(geo, edgeMaterial);
      edge.position.set(0, edgeHeight / 2, z);
      edge.receiveShadow = true;
      edge.castShadow = true;
      this.mesh.add(edge);
    }

    // Left and right edges
    const sideEdgeGeo = new THREE.BoxGeometry(edgeWidth, edgeHeight, depth);
    const leftEdge = new THREE.Mesh(sideEdgeGeo, edgeMaterial);
    leftEdge.position.set(-(width / 2 + edgeWidth / 2), edgeHeight / 2, 0);
    leftEdge.receiveShadow = true;
    leftEdge.castShadow = true;
    this.mesh.add(leftEdge);

    const rightEdge = new THREE.Mesh(sideEdgeGeo, edgeMaterial);
    rightEdge.position.set(width / 2 + edgeWidth / 2, edgeHeight / 2, 0);
    rightEdge.receiveShadow = true;
    rightEdge.castShadow = true;
    this.mesh.add(rightEdge);

    // Store reference for disposal
    this.edgeMesh = leftEdge;
  }

  dispose(): void {
    this.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
    });
  }
}
