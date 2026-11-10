export interface PlaceRow {
  id: string;
  city: string;
  name: string;
  category: string;
  verified: boolean;
  source: string;
  lat: number | null;
  lng: number | null;
  payload: Record<string, unknown> | null;
  distance?: number;
}

export interface RankedPlace {
  row: PlaceRow;
  /** 同一实体的原始行 ID；只合并同一地点的证据。 */
  ids: string[];
  aliases: string[];
}

export interface EvidenceItem {
  kind: string;
  content: string;
  strength: string;
  sourceUrl?: string;
}

export interface RetrievedPlace extends PlaceRow {
  canonicalPlaceId?: string;
  aliases: string[];
  evidence: EvidenceItem[];
}
