import * as THREE from 'three';
import type { Card, Rank, Suit } from '../../../../shared/data-types/src/go-fish-types';

const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7'];
const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs'];

const CARD_WIDTH = 200;
const CARD_HEIGHT = 280;

function getSuitSymbol(suit: Suit): string {
  const symbols: Record<Suit, string> = { hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' };
  return symbols[suit] || '?';
}

function getCardColor(suit: Suit): string {
  return suit === 'hearts' || suit === 'diamonds' ? '#dc2626' : '#1f2937';
}

function renderCardFace(ctx: CanvasRenderingContext2D, rank: Rank, suit: Suit): void {
  const w = CARD_WIDTH;
  const h = CARD_HEIGHT;
  const color = getCardColor(suit);
  const symbol = getSuitSymbol(suit);

  // White card background with rounded corners
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 12);
  ctx.fill();

  // Border
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, 10);
  ctx.stroke();

  ctx.fillStyle = color;

  // Top-left rank
  ctx.font = 'bold 36px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(rank, 14, 14);

  // Top-left suit symbol
  ctx.font = '28px "Segoe UI", Arial, sans-serif';
  ctx.fillText(symbol, 14, 52);

  // Center suit (large)
  ctx.font = '80px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(symbol, w / 2, h / 2);

  // Bottom-right (rotated 180)
  ctx.save();
  ctx.translate(w, h);
  ctx.rotate(Math.PI);
  ctx.font = 'bold 36px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(rank, 14, 14);
  ctx.font = '28px "Segoe UI", Arial, sans-serif';
  ctx.fillText(symbol, 14, 52);
  ctx.restore();
}

function renderCardBack(ctx: CanvasRenderingContext2D): void {
  const w = CARD_WIDTH;
  const h = CARD_HEIGHT;

  // Dark green background
  ctx.fillStyle = '#1a472a';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 12);
  ctx.fill();

  // Border
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, 10);
  ctx.stroke();

  // Dot pattern
  ctx.fillStyle = '#2d6b3f';
  for (let x = 20; x < w - 10; x += 20) {
    for (let y = 20; y < h - 10; y += 20) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Inner border decoration
  ctx.strokeStyle = '#2d6b3f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(16, 16, w - 32, h - 32, 6);
  ctx.stroke();

  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(22, 22, w - 44, h - 44, 6);
  ctx.stroke();
}

/**
 * Generates and caches all card face textures and the card back texture.
 */
export class CardTextureAtlas {
  private faceTextures = new Map<string, THREE.CanvasTexture>();
  private backTexture: THREE.CanvasTexture | null = null;

  private static makeKey(rank: Rank, suit: Suit): string {
    return `${rank}-${suit}`;
  }

  /** Generate all 21 card textures + 1 back texture. Call once at init. */
  generateAll(): void {
    for (const rank of RANKS) {
      for (const suit of SUITS) {
        const canvas = document.createElement('canvas');
        canvas.width = CARD_WIDTH;
        canvas.height = CARD_HEIGHT;
        const ctx = canvas.getContext('2d')!;
        renderCardFace(ctx, rank, suit);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        this.faceTextures.set(CardTextureAtlas.makeKey(rank, suit), texture);
      }
    }

    // Card back
    const backCanvas = document.createElement('canvas');
    backCanvas.width = CARD_WIDTH;
    backCanvas.height = CARD_HEIGHT;
    const backCtx = backCanvas.getContext('2d')!;
    renderCardBack(backCtx);
    this.backTexture = new THREE.CanvasTexture(backCanvas);
    this.backTexture.colorSpace = THREE.SRGBColorSpace;
    this.backTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.backTexture.magFilter = THREE.LinearFilter;
  }

  getFaceTexture(card: Card): THREE.CanvasTexture {
    const key = CardTextureAtlas.makeKey(card.rank, card.suit);
    const tex = this.faceTextures.get(key);
    if (!tex) throw new Error(`No texture for card ${key}. Call generateAll() first.`);
    return tex;
  }

  getBackTexture(): THREE.CanvasTexture {
    if (!this.backTexture) throw new Error('No back texture. Call generateAll() first.');
    return this.backTexture;
  }

  dispose(): void {
    for (const tex of this.faceTextures.values()) tex.dispose();
    this.faceTextures.clear();
    this.backTexture?.dispose();
    this.backTexture = null;
  }
}
