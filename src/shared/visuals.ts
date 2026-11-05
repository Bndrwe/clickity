// Visual explainers the model can attach to a reply: 2D cards and draggable 3D models.
// Protocol tags are parsed in src/main/visual-tags.ts; rendered by src/renderer/shared/visuals.ts.

export const MODEL3D_KINDS = [
  'cube',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'pyramid',
  'molecule-h2o',
  'molecule-co2',
  'atom',
  'gear',
  'planet-earth',
  'solar-system',
  'dna-helix',
  'arrow-axes',
] as const;

export type Model3DKind = (typeof MODEL3D_KINDS)[number];

export interface CardVisual {
  type: 'card';
  title: string;
  /** at most 6 short lines */
  lines: string[];
}

export interface Model3DVisual {
  type: 'model3d';
  kind: Model3DKind;
  label: string;
}

/** A card or 3D model attached to an assistant turn (ChatTurn.visuals, IPC.overlayVisuals). */
export type ChatVisual = CardVisual | Model3DVisual;
