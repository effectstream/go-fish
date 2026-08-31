import { Uniform } from 'three';
import { Effect } from 'postprocessing';

const fragmentShader = /* glsl */ `
uniform float scanlineIntensity;
uniform float curvature;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // Barrel distortion
  vec2 centered = uv - 0.5;
  float dist = dot(centered, centered);
  vec2 distortedUv = uv + centered * dist * curvature;

  // Clamp to avoid sampling outside texture
  distortedUv = clamp(distortedUv, 0.0, 1.0);

  // Sample the scene color at distorted coordinates
  vec4 color = texture2D(inputBuffer, distortedUv);

  // Scanlines — vertical frequency based on resolution
  float scanline = sin(distortedUv.y * resolution.y * 0.5) * scanlineIntensity;
  color.rgb -= scanline;

  // Subtle horizontal line flicker
  float flicker = sin(distortedUv.y * resolution.y * 1.5 + time * 2.0) * scanlineIntensity * 0.3;
  color.rgb -= flicker;

  outputColor = color;
}
`;

interface CRTEffectOptions {
  scanlineIntensity?: number;
  curvature?: number;
}

/**
 * Custom CRT scanline and barrel distortion effect for Balatro-style retro feel.
 * Intentionally subtle — enhances atmosphere without being distracting.
 */
export class CRTEffect extends Effect {
  constructor({
    scanlineIntensity = 0.04,
    curvature = 0.015,
  }: CRTEffectOptions = {}) {
    super('CRTEffect', fragmentShader, {
      uniforms: new Map([
        ['scanlineIntensity', new Uniform(scanlineIntensity)],
        ['curvature', new Uniform(curvature)],
      ]),
    });
  }
}
