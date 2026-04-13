import * as THREE from 'three';
import type { Card } from '../../../../shared/data-types/src/go-fish-types';
import type { CardTextureAtlas } from '../textures/CardTextureAtlas';

const CARD_WIDTH = 1.0;
const CARD_HEIGHT = 1.4;
const CARD_DEPTH = 0.02;

/**
 * A single 3D playing card with front face texture and back face texture.
 * Supports hover interactions (tilt, scale, lift, glow).
 */
export class Card3D {
  readonly mesh: THREE.Group;
  readonly card: Card;
  readonly faceUp: boolean;

  private cardMesh: THREE.Mesh;
  private glowMesh: THREE.Mesh;

  // Hover/selection state
  private _hovered = false;
  private _selected = false;
  private _interactive = true;
  private restPosition = new THREE.Vector3();
  private restRotation = new THREE.Euler();

  constructor(card: Card, atlas: CardTextureAtlas, faceUp: boolean = true) {
    this.card = card;
    this.faceUp = faceUp;
    this.mesh = new THREE.Group();

    // Card geometry — thin box
    const geometry = new THREE.BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH);

    // Materials: 6 faces of a box [+x, -x, +y, -y, +z (front), -z (back)]
    const faceTex = faceUp ? atlas.getFaceTexture(card) : atlas.getBackTexture();
    const backTex = atlas.getBackTexture();

    const edgeMaterial = new THREE.MeshStandardMaterial({
      color: 0xeeeeee,
      roughness: 0.5,
    });

    const frontMaterial = new THREE.MeshStandardMaterial({
      map: faceTex,
      roughness: 0.4,
      metalness: 0.0,
    });

    const backMaterial = new THREE.MeshStandardMaterial({
      map: backTex,
      roughness: 0.4,
      metalness: 0.0,
    });

    // Box faces: right, left, top, bottom, front (+Z), back (-Z)
    const materials = [
      edgeMaterial, // right
      edgeMaterial, // left
      edgeMaterial, // top
      edgeMaterial, // bottom
      frontMaterial, // front (+Z)
      backMaterial,  // back (-Z)
    ];

    this.cardMesh = new THREE.Mesh(geometry, materials);
    this.cardMesh.castShadow = true;
    this.cardMesh.receiveShadow = true;
    // Rotate so card face points up (toward camera)
    this.cardMesh.rotation.x = -Math.PI / 2;
    this.mesh.add(this.cardMesh);

    // Glow plane (slightly larger, behind the card, emissive)
    const glowGeometry = new THREE.PlaneGeometry(CARD_WIDTH * 1.15, CARD_HEIGHT * 1.15);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffaa00,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
    });
    this.glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    this.glowMesh.rotation.x = -Math.PI / 2;
    this.glowMesh.position.y = -0.01; // Just below the card
    this.mesh.add(this.glowMesh);

    // Store userData for raycaster identification
    this.cardMesh.userData.card3d = this;
  }

  /** The Mesh used for raycaster intersection (the card body, not glow). */
  get hitTarget(): THREE.Mesh {
    return this.cardMesh;
  }

  get hovered(): boolean { return this._hovered; }
  get selected(): boolean { return this._selected; }

  setRestPose(position: THREE.Vector3, rotation: THREE.Euler): void {
    this.restPosition.copy(position);
    this.restRotation.copy(rotation);
    this.mesh.position.copy(position);
    this.mesh.rotation.copy(rotation);
  }

  /** Called each frame to update hover/selection visuals. */
  updateInteraction(mouseNDC: THREE.Vector2 | null): void {
    const glowMat = this.glowMesh.material as THREE.MeshBasicMaterial;

    if (this._selected) {
      // Selected: lifted, orange glow, subtle float
      this.mesh.position.y = this.restPosition.y + 0.5;
      glowMat.opacity = 0.4;
      glowMat.color.setHex(0xffaa00);
    } else if (this._hovered && this._interactive && mouseNDC) {
      // Hovered + interactive: lift, scale, tilt toward mouse
      this.mesh.position.y = this.restPosition.y + 0.3;
      this.mesh.scale.setScalar(1.08);

      // Tilt toward mouse position (subtle)
      this.cardMesh.rotation.x = -Math.PI / 2 + mouseNDC.y * 0.1;
      this.cardMesh.rotation.z = mouseNDC.x * 0.1;

      glowMat.opacity = 0.25;
      glowMat.color.setHex(0x88ccff);
    } else {
      // Rest state
      this.mesh.position.copy(this.restPosition);
      this.mesh.scale.setScalar(1.0);
      this.cardMesh.rotation.x = -Math.PI / 2;
      this.cardMesh.rotation.z = 0;
      glowMat.opacity = 0.0;
    }
  }

  setHovered(hovered: boolean): void {
    this._hovered = hovered;
  }

  setSelected(selected: boolean): void {
    this._selected = selected;
  }

  get interactive(): boolean { return this._interactive; }

  setInteractive(interactive: boolean): void {
    this._interactive = interactive;
  }

  dispose(): void {
    this.cardMesh.geometry.dispose();
    const mats = this.cardMesh.material;
    if (Array.isArray(mats)) {
      for (const m of mats) m.dispose();
    }
    this.glowMesh.geometry.dispose();
    (this.glowMesh.material as THREE.Material).dispose();
  }
}
