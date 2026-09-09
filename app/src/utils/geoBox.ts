export interface LatLonBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

// Wikipedia articles are static — once an area's been fetched there's no
// need to re-fetch it just because the viewport shifted slightly within it.
// Padding the fetched area beyond the viewport it was requested for means
// small pans stay covered by what's already on screen.
export function padBox(box: LatLonBox, factor: number): LatLonBox {
  const latPad = (box.north - box.south) * factor;
  const lonPad = (box.east - box.west) * factor;
  return {
    south: box.south - latPad,
    north: box.north + latPad,
    west: box.west - lonPad,
    east: box.east + lonPad,
  };
}

export function boxContains(outer: LatLonBox, inner: LatLonBox): boolean {
  return (
    outer.south <= inner.south && outer.north >= inner.north && outer.west <= inner.west && outer.east >= inner.east
  );
}
