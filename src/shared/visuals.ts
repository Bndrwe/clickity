// Visual explainers the model can attach to a reply: 2D cards, draggable 3D models and charts.
// Protocol tags are parsed in src/main/visual-tags.ts (charts: src/shared/charts.ts); rendered by
// src/renderer/shared/visuals.ts (charts: src/renderer/shared/charts.ts).

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

export const CHART_KINDS = ['line', 'bar', 'scatter', 'pie', 'plot'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** One series: `values` (line / bar / pie, by `labels`), `points` (scatter) or `expr` (plot, in x). */
export interface ChartSeries {
  name: string;
  values?: number[];
  points?: [number, number][];
  expr?: string;
}

/** A small chart or function plot ([CHART:kind|title|…]). */
export interface ChartVisual {
  type: 'chart';
  kind: ChartKind;
  title: string;
  /** axis labels */
  x?: string;
  y?: string;
  /** category labels (line / bar / pie) */
  labels?: string[];
  /** at most 4 series (pie: one) */
  series: ChartSeries[];
  /** plot: the x range */
  domain?: [number, number];
  /** plot: an optional y range */
  range?: [number, number];
}

/** A card, 3D model or chart attached to an assistant turn (ChatTurn.visuals, IPC.overlayVisuals). */
export type ChatVisual = CardVisual | Model3DVisual | ChartVisual;
