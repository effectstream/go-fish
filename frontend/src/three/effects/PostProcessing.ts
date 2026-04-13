import * as THREE from 'three';
import {
  EffectComposer,
  EffectPass,
  RenderPass,
  BloomEffect,
  ChromaticAberrationEffect,
  VignetteEffect,
  KernelSize,
} from 'postprocessing';
import { CRTEffect } from './CRTEffect';

/**
 * Sets up Balatro-style post-processing effects:
 * - Bloom (soft glow on bright elements)
 * - Chromatic aberration (subtle RGB fringing)
 * - Vignette (darkened edges)
 * - CRT scanlines + barrel distortion (subtle retro feel)
 */
export function createPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): EffectComposer {
  const composer = new EffectComposer(renderer);

  // Base render pass
  composer.addPass(new RenderPass(scene, camera));

  // Bloom — soft glow on bright areas (card glows, lights)
  const bloomEffect = new BloomEffect({
    intensity: 0.6,
    luminanceThreshold: 0.55,
    luminanceSmoothing: 0.3,
    kernelSize: KernelSize.MEDIUM,
    mipmapBlur: true,
  });

  // Chromatic aberration — subtle RGB offset at edges
  const chromaticAberration = new ChromaticAberrationEffect({
    offset: new THREE.Vector2(0.0008, 0.0008),
    radialModulation: true,
    modulationOffset: 0.3,
  });

  // Vignette — darken the edges for focus effect
  const vignetteEffect = new VignetteEffect({
    darkness: 0.5,
    offset: 0.3,
  });

  // CRT scanlines + subtle barrel distortion
  const crtEffect = new CRTEffect({
    scanlineIntensity: 0.04,
    curvature: 0.015,
  });

  // Combine all effects into a single pass for performance
  composer.addPass(new EffectPass(camera, bloomEffect, chromaticAberration, vignetteEffect));
  composer.addPass(new EffectPass(camera, crtEffect));

  return composer;
}
