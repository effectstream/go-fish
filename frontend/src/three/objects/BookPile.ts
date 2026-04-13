import * as THREE from 'three';
import type { Rank } from '../../../../shared/data-types/src/go-fish-types';

/**
 * Displays completed books (sets of 3 matching cards) as small stacked card piles.
 */
export class BookPile {
  readonly group: THREE.Group;
  private bookMeshes: THREE.Group[] = [];

  constructor() {
    this.group = new THREE.Group();
  }

  /** Update the displayed books. */
  setBooks(books: string[]): void {
    this.clear();

    const spacing = 1.4;
    const startX = -((books.length - 1) * spacing) / 2;

    for (let i = 0; i < books.length; i++) {
      const rank = books[i] as Rank;
      const bookGroup = this.createBookStack(rank);
      bookGroup.position.x = startX + i * spacing;
      this.bookMeshes.push(bookGroup);
      this.group.add(bookGroup);
    }
  }

  private createBookStack(rank: Rank): THREE.Group {
    const bookGroup = new THREE.Group();

    // 3 stacked cards with slight offsets
    const geometry = new THREE.BoxGeometry(0.8, 1.1, 0.02);
    const material = new THREE.MeshStandardMaterial({
      color: 0x2e7d32,
      roughness: 0.5,
    });

    for (let i = 0; i < 3; i++) {
      const card = new THREE.Mesh(geometry, material);
      card.rotation.x = -Math.PI / 2;
      card.position.y = i * 0.02;
      card.position.x = (Math.random() - 0.5) * 0.04;
      card.position.z = (Math.random() - 0.5) * 0.04;
      card.rotation.z = (Math.random() - 0.5) * 0.03;
      bookGroup.add(card);
    }

    // Rank label sprite
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = 'rgba(255, 170, 0, 0.8)';
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 32px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(rank, 32, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true }),
    );
    sprite.scale.set(0.4, 0.4, 1);
    sprite.position.y = 0.3;
    bookGroup.add(sprite);

    return bookGroup;
  }

  private clear(): void {
    for (const mesh of this.bookMeshes) {
      mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) child.material.dispose();
        }
        if (child instanceof THREE.Sprite) {
          child.material.dispose();
          child.material.map?.dispose();
        }
      });
      this.group.remove(mesh);
    }
    this.bookMeshes = [];
  }

  dispose(): void {
    this.clear();
  }
}
