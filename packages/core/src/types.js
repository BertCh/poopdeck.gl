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
/** Feature change type for delta encoding */
export var ChangeType;
(function (ChangeType) {
    ChangeType[ChangeType["Unchanged"] = 0] = "Unchanged";
    ChangeType[ChangeType["Created"] = 1] = "Created";
    ChangeType[ChangeType["Modified"] = 2] = "Modified";
    ChangeType[ChangeType["Deleted"] = 3] = "Deleted";
})(ChangeType || (ChangeType = {}));
/** Interpolation method for temporal transitions */
export var InterpolationMethod;
(function (InterpolationMethod) {
    InterpolationMethod[InterpolationMethod["None"] = 0] = "None";
    InterpolationMethod[InterpolationMethod["Linear"] = 1] = "Linear";
    InterpolationMethod[InterpolationMethod["Step"] = 2] = "Step";
    InterpolationMethod[InterpolationMethod["Cubic"] = 3] = "Cubic";
})(InterpolationMethod || (InterpolationMethod = {}));
//# sourceMappingURL=types.js.map