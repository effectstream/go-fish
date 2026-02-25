import * as THREE from 'three';
import gsap from 'gsap';
import type { CardTextureAtlas } from '../textures/CardTextureAtlas';

const CARD_WIDTH = 1.0;
const CARD_HEIGHT = 1.4;
const CARD_DEPTH = 0.02;
const CARD_SPACING = 0.35;
const ARC_CURVATURE = 0.02;

/**
 * Opponent's hand displayed as face-down cards in an arc on the far side of the table.
 * Supports a highlight/glow effect for opponent selection mode.
 */
export class OpponentHand {
  readonly group: THREE.Group;
  private cardMeshes: THREE.Mesh[] = [];
  private nameLabel: THREE.Sprite | null = null;
  private atlas: CardTextureAtlas;
  private glowMesh: THREE.Mesh;
  private glowTween: gsap.core.Tween | null = null;
  private _highlighted = false;

  constructor(atlas: CardTextureAtlas) {
    this.atlas = atlas;
    this.group = new THREE.Group();

    // Glow plane behind opponent cards (initially invisible)
    const glowGeometry = new THREE.PlaneGeometry(6, 2.5);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffaa00,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
    });
    this.glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    this.glowMesh.rotation.x = -Math.PI / 2;
    this.glowMesh.position.y = -0.02;
    this.group.add(this.glowMesh);
  }

  /** Set whether the opponent area is highlighted (for selection mode). */
  setHighlighted(highlighted: boolean): void {
    if (highlighted === this._highlighted) return;
    this._highlighted = highlighted;

    if (this.glowTween) {
      this.glowTween.kill();
      this.glowTween = null;
    }

    const mat = this.glowMesh.material as THREE.MeshBasicMaterial;

    if (highlighted) {
      mat.color.setHex(0xffaa00);
      this.glowTween = gsap.to(mat, {
        opacity: 0.3,
        duration: 0.6,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });
    } else {
      gsap.to(mat, { opacity: 0.0, duration: 0.25 });
    }
  }

  get highlighted(): boolean { return this._highlighted; }

  /** Update the number of face-down cards shown. */
  setCardCount(count: number): void {
    this.clearCards();
    if (count <= 0) return;

    const backTex = this.atlas.getBackTexture();
    const material = new THREE.MeshStandardMaterial({
      map: backTex,
      roughness: 0.4,
      metalness: 0.0,
    });
    const edgeMaterial = new THREE.MeshStandardMaterial({
      color: 0xeeeeee,
      roughness: 0.5,
    });

    const totalWidth = (count - 1) * CARD_SPACING;
    const startX = -totalWidth / 2;

    for (let i = 0; i < count; i++) {
      const geometry = new THREE.BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH);
      const materials = [
        edgeMaterial, edgeMaterial, edgeMaterial, edgeMaterial,
        material, material,
      ];
      const cardMesh = new THREE.Mesh(geometry, materials);

      const t = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;

      cardMesh.rotation.x = -Math.PI / 2;
      cardMesh.position.x = startX + i * CARD_SPACING;
      cardMesh.position.y = 0.05 + i * 0.001;
      cardMesh.position.z = -t * t * ARC_CURVATURE * count;
      cardMesh.rotation.z = -t * 0.015;

      cardMesh.castShadow = true;
      this.cardMeshes.push(cardMesh);
      this.group.add(cardMesh);
    }
  }

  /** Set the opponent's display name. */
  setName(name: string): void {
    if (this.nameLabel) {
      this.group.remove(this.nameLabel);
      this.nameLabel.material.dispose();
      (this.nameLabel.material as THREE.SpriteMaterial).map?.dispose();
      this.nameLabel = null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 256, 64, 12);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 128, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
    });

    this.nameLabel = new THREE.Sprite(spriteMaterial);
    this.nameLabel.scale.set(2.0, 0.5, 1);
    this.nameLabel.position.set(0, 0.6, -1.2);
    this.group.add(this.nameLabel);
  }

  private clearCards(): void {
    for (const m of this.cardMeshes) {
      m.geometry.dispose();
    }
    this.cardMeshes = [];

    // Remove card meshes (keep name label and glow mesh)
    const toRemove = this.group.children.filter(c => c !== this.nameLabel && c !== this.glowMesh);
    for (const child of toRemove) {
      this.group.remove(child);
    }
  }

  dispose(): void {
    this.setHighlighted(false);
    this.clearCards();
    if (this.nameLabel) {
      this.group.remove(this.nameLabel);
      this.nameLabel.material.dispose();
      (this.nameLabel.material as THREE.SpriteMaterial).map?.dispose();
      this.nameLabel = null;
    }
    this.glowMesh.geometry.dispose();
    (this.glowMesh.material as THREE.Material).dispose();
  }
}
