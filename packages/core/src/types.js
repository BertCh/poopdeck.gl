/**
 * Core types for spatiotemporal tiles
 */
/** Compression method for tiles */
export var Compression;
(function (Compression) {
    Compression[Compression["None"] = 0] = "None";
    Compression[Compression["Gzip"] = 1] = "Gzip";
    Compression[Compression["Brotli"] = 2] = "Brotli";
})(Compression || (Compression = {}));
/** Geometry type */
export var GeometryType;
(function (GeometryType) {
    GeometryType[GeometryType["Point"] = 0] = "Point";
    GeometryType[GeometryType["LineString"] = 1] = "LineString";
    GeometryType[GeometryType["Polygon"] = 2] = "Polygon";
})(GeometryType || (GeometryType = {}));
//# sourceMappingURL=types.js.map