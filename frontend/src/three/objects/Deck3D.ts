import * as THREE from 'three';
import gsap from 'gsap';
import type { CardTextureAtlas } from '../textures/CardTextureAtlas';

const CARD_WIDTH = 1.0;
const CARD_HEIGHT = 1.4;
const CARD_DEPTH = 0.02;
const MAX_VISIBLE_CARDS = 8;

/**
 * A stack of cards at the center of the table representing the draw deck.
 * Shows multiple cards stacked with slight offsets for a 3D pile look.
 * Supports a glow/pulse effect to indicate interactivity.
 */
export class Deck3D {
  readonly mesh: THREE.Group;
  private cardMeshes: THREE.Mesh[] = [];
  private countLabel: THREE.Sprite | null = null;
  private atlas: CardTextureAtlas;
  private glowMesh: THREE.Mesh | null = null;
  private glowTween: gsap.core.Tween | null = null;
  private _glowing = false;

  constructor(atlas: CardTextureAtlas) {
    this.atlas = atlas;
    this.mesh = new THREE.Group();
    this.createGlow();
  }

  /** Create the glow plane that sits just below the deck stack. */
  private createGlow(): void {
    const glowGeometry = new THREE.PlaneGeometry(CARD_WIDTH * 1.4, CARD_HEIGHT * 1.4);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0x44aaff,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
    });
    this.glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    this.glowMesh.rotation.x = -Math.PI / 2;
    this.glowMesh.position.y = -0.01;
    this.mesh.add(this.glowMesh);
  }

  /** Start pulsing the glow to indicate the deck is clickable. */
  setGlowing(glowing: boolean): void {
    if (glowing === this._glowing) return;
    this._glowing = glowing;

    if (this.glowTween) {
      this.glowTween.kill();
      this.glowTween = null;
    }

    const mat = this.glowMesh?.material as THREE.MeshBasicMaterial | undefined;
    if (!mat) return;

    if (glowing) {
      mat.color.setHex(0x44aaff);
      this.glowTween = gsap.to(mat, {
        opacity: 0.35,
        duration: 0.8,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });
    } else {
      gsap.to(mat, { opacity: 0.0, duration: 0.3 });
    }
  }

  get glowing(): boolean { return this._glowing; }

  /** Update the visual representation based on remaining card count. */
  setCount(count: number): void {
    this.clear();
    if (count <= 0) return;

    const visibleCards = Math.min(count, MAX_VISIBLE_CARDS);
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

    for (let i = 0; i < visibleCards; i++) {
      const geometry = new THREE.BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH);
      const materials = [
        edgeMaterial, edgeMaterial, edgeMaterial, edgeMaterial,
        material, material,
      ];
      const cardMesh = new THREE.Mesh(geometry, materials);

      // Stack cards with slight random offsets for realism
      cardMesh.rotation.x = -Math.PI / 2;
      cardMesh.position.y = i * CARD_DEPTH;
      cardMesh.position.x = (Math.random() - 0.5) * 0.03;
      cardMesh.position.z = (Math.random() - 0.5) * 0.03;
      cardMesh.rotation.z = (Math.random() - 0.5) * 0.02;

      cardMesh.castShadow = true;
      cardMesh.receiveShadow = true;

      this.cardMeshes.push(cardMesh);
      this.mesh.add(cardMesh);
    }

    // Count label sprite
    this.updateCountLabel(count);
  }

  private updateCountLabel(count: number): void {
    if (this.countLabel) {
      this.mesh.remove(this.countLabel);
      this.countLabel.material.dispose();
      (this.countLabel.material as THREE.SpriteMaterial).map?.dispose();
    }

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 128, 64, 12);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${count}`, 64, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
    });

    this.countLabel = new THREE.Sprite(spriteMaterial);
    this.countLabel.scale.set(0.8, 0.4, 1);
    this.countLabel.position.y = 0.6;
    this.mesh.add(this.countLabel);
  }

  private clear(): void {
    for (const m of this.cardMeshes) {
      m.geometry.dispose();
      // Materials are shared, disposed separately
    }
    this.cardMeshes = [];

    if (this.countLabel) {
      this.mesh.remove(this.countLabel);
      this.countLabel.material.dispose();
      (this.countLabel.material as THREE.SpriteMaterial).map?.dispose();
      this.countLabel = null;
    }

    // Remove all children except the glow mesh
    const children = [...this.mesh.children];
    for (const child of children) {
      if (child !== this.glowMesh) {
        this.mesh.remove(child);
      }
    }
  }

  dispose(): void {
    this.setGlowing(false);
    this.clear();
    if (this.glowMesh) {
      this.glowMesh.geometry.dispose();
      (this.glowMesh.material as THREE.Material).dispose();
    }
  }
}
