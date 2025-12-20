/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/
import * as $protobuf from "protobufjs/minimal";

// Common aliases
const $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

// Exported root namespace
const $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

export const stt = $root.stt = (() => {

    /**
     * Namespace stt.
     * @exports stt
     * @namespace
     */
    const stt = {};

    stt.Index = (function() {

        /**
         * Properties of an Index.
         * @memberof stt
         * @interface IIndex
         * @property {Array.<stt.ITileEntry>|null} [tiles] Index tiles
         * @property {stt.ISpatialIndex|null} [spatial] Index spatial
         * @property {stt.ITemporalIndex|null} [temporal] Index temporal
         */

        /**
         * Constructs a new Index.
         * @memberof stt
         * @classdesc Represents an Index.
         * @implements IIndex
         * @constructor
         * @param {stt.IIndex=} [properties] Properties to set
         */
        function Index(properties) {
            this.tiles = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Index tiles.
         * @member {Array.<stt.ITileEntry>} tiles
         * @memberof stt.Index
         * @instance
         */
        Index.prototype.tiles = $util.emptyArray;

        /**
         * Index spatial.
         * @member {stt.ISpatialIndex|null|undefined} spatial
         * @memberof stt.Index
         * @instance
         */
        Index.prototype.spatial = null;

        /**
         * Index temporal.
         * @member {stt.ITemporalIndex|null|undefined} temporal
         * @memberof stt.Index
         * @instance
         */
        Index.prototype.temporal = null;

        /**
         * Creates a new Index instance using the specified properties.
         * @function create
         * @memberof stt.Index
         * @static
         * @param {stt.IIndex=} [properties] Properties to set
         * @returns {stt.Index} Index instance
         */
        Index.create = function create(properties) {
            return new Index(properties);
        };

        /**
         * Encodes the specified Index message. Does not implicitly {@link stt.Index.verify|verify} messages.
         * @function encode
         * @memberof stt.Index
         * @static
         * @param {stt.IIndex} message Index message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Index.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.tiles != null && message.tiles.length)
                for (let i = 0; i < message.tiles.length; ++i)
                    $root.stt.TileEntry.encode(message.tiles[i], writer.uint32(/* id 1, wireType 2 =*/10).fork()).ldelim();
            if (message.spatial != null && Object.hasOwnProperty.call(message, "spatial"))
                $root.stt.SpatialIndex.encode(message.spatial, writer.uint32(/* id 2, wireType 2 =*/18).fork()).ldelim();
            if (message.temporal != null && Object.hasOwnProperty.call(message, "temporal"))
                $root.stt.TemporalIndex.encode(message.temporal, writer.uint32(/* id 3, wireType 2 =*/26).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified Index message, length delimited. Does not implicitly {@link stt.Index.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.Index
         * @static
         * @param {stt.IIndex} message Index message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Index.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes an Index message from the specified reader or buffer.
         * @function decode
         * @memberof stt.Index
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.Index} Index
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Index.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.Index();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        if (!(message.tiles && message.tiles.length))
                            message.tiles = [];
                        message.tiles.push($root.stt.TileEntry.decode(reader, reader.uint32()));
                        break;
                    }
                case 2: {
                        message.spatial = $root.stt.SpatialIndex.decode(reader, reader.uint32());
                        break;
                    }
                case 3: {
                        message.temporal = $root.stt.TemporalIndex.decode(reader, reader.uint32());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes an Index message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.Index
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.Index} Index
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Index.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies an Index message.
         * @function verify
         * @memberof stt.Index
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Index.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.tiles != null && message.hasOwnProperty("tiles")) {
                if (!Array.isArray(message.tiles))
                    return "tiles: array expected";
                for (let i = 0; i < message.tiles.length; ++i) {
                    let error = $root.stt.TileEntry.verify(message.tiles[i]);
                    if (error)
                        return "tiles." + error;
                }
            }
            if (message.spatial != null && message.hasOwnProperty("spatial")) {
                let error = $root.stt.SpatialIndex.verify(message.spatial);
                if (error)
                    return "spatial." + error;
            }
            if (message.temporal != null && message.hasOwnProperty("temporal")) {
                let error = $root.stt.TemporalIndex.verify(message.temporal);
                if (error)
                    return "temporal." + error;
            }
            return null;
        };

        /**
         * Creates an Index message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.Index
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.Index} Index
         */
        Index.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.Index)
                return object;
            let message = new $root.stt.Index();
            if (object.tiles) {
                if (!Array.isArray(object.tiles))
                    throw TypeError(".stt.Index.tiles: array expected");
                message.tiles = [];
                for (let i = 0; i < object.tiles.length; ++i) {
                    if (typeof object.tiles[i] !== "object")
                        throw TypeError(".stt.Index.tiles: object expected");
                    message.tiles[i] = $root.stt.TileEntry.fromObject(object.tiles[i]);
                }
            }
            if (object.spatial != null) {
                if (typeof object.spatial !== "object")
                    throw TypeError(".stt.Index.spatial: object expected");
                message.spatial = $root.stt.SpatialIndex.fromObject(object.spatial);
            }
            if (object.temporal != null) {
                if (typeof object.temporal !== "object")
                    throw TypeError(".stt.Index.temporal: object expected");
                message.temporal = $root.stt.TemporalIndex.fromObject(object.temporal);
            }
            return message;
        };

        /**
         * Creates a plain object from an Index message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.Index
         * @static
         * @param {stt.Index} message Index
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Index.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.tiles = [];
            if (options.defaults) {
                object.spatial = null;
                object.temporal = null;
            }
            if (message.tiles && message.tiles.length) {
                object.tiles = [];
                for (let j = 0; j < message.tiles.length; ++j)
                    object.tiles[j] = $root.stt.TileEntry.toObject(message.tiles[j], options);
            }
            if (message.spatial != null && message.hasOwnProperty("spatial"))
                object.spatial = $root.stt.SpatialIndex.toObject(message.spatial, options);
            if (message.temporal != null && message.hasOwnProperty("temporal"))
                object.temporal = $root.stt.TemporalIndex.toObject(message.temporal, options);
            return object;
        };

        /**
         * Converts this Index to JSON.
         * @function toJSON
         * @memberof stt.Index
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Index.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for Index
         * @function getTypeUrl
         * @memberof stt.Index
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        Index.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.Index";
        };

        return Index;
    })();

    stt.TileEntry = (function() {

        /**
         * Properties of a TileEntry.
         * @memberof stt
         * @interface ITileEntry
         * @property {number|null} [zoom] TileEntry zoom
         * @property {number|null} [x] TileEntry x
         * @property {number|null} [y] TileEntry y
         * @property {number|Long|null} [timeStart] TileEntry timeStart
         * @property {number|Long|null} [timeEnd] TileEntry timeEnd
         * @property {number|Long|null} [offset] TileEntry offset
         * @property {number|null} [length] TileEntry length
         * @property {number|null} [featureCount] TileEntry featureCount
         * @property {stt.TileEntry.Compression|null} [compression] TileEntry compression
         * @property {number|null} [uncompressedSize] TileEntry uncompressedSize
         */

        /**
         * Constructs a new TileEntry.
         * @memberof stt
         * @classdesc Represents a TileEntry.
         * @implements ITileEntry
         * @constructor
         * @param {stt.ITileEntry=} [properties] Properties to set
         */
        function TileEntry(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * TileEntry zoom.
         * @member {number} zoom
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.zoom = 0;

        /**
         * TileEntry x.
         * @member {number} x
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.x = 0;

        /**
         * TileEntry y.
         * @member {number} y
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.y = 0;

        /**
         * TileEntry timeStart.
         * @member {number|Long} timeStart
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.timeStart = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * TileEntry timeEnd.
         * @member {number|Long} timeEnd
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.timeEnd = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * TileEntry offset.
         * @member {number|Long} offset
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.offset = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * TileEntry length.
         * @member {number} length
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.length = 0;

        /**
         * TileEntry featureCount.
         * @member {number} featureCount
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.featureCount = 0;

        /**
         * TileEntry compression.
         * @member {stt.TileEntry.Compression} compression
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.compression = 0;

        /**
         * TileEntry uncompressedSize.
         * @member {number} uncompressedSize
         * @memberof stt.TileEntry
         * @instance
         */
        TileEntry.prototype.uncompressedSize = 0;

        /**
         * Creates a new TileEntry instance using the specified properties.
         * @function create
         * @memberof stt.TileEntry
         * @static
         * @param {stt.ITileEntry=} [properties] Properties to set
         * @returns {stt.TileEntry} TileEntry instance
         */
        TileEntry.create = function create(properties) {
            return new TileEntry(properties);
        };

        /**
         * Encodes the specified TileEntry message. Does not implicitly {@link stt.TileEntry.verify|verify} messages.
         * @function encode
         * @memberof stt.TileEntry
         * @static
         * @param {stt.ITileEntry} message TileEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TileEntry.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.zoom != null && Object.hasOwnProperty.call(message, "zoom"))
                writer.uint32(/* id 1, wireType 0 =*/8).uint32(message.zoom);
            if (message.x != null && Object.hasOwnProperty.call(message, "x"))
                writer.uint32(/* id 2, wireType 0 =*/16).uint32(message.x);
            if (message.y != null && Object.hasOwnProperty.call(message, "y"))
                writer.uint32(/* id 3, wireType 0 =*/24).uint32(message.y);
            if (message.timeStart != null && Object.hasOwnProperty.call(message, "timeStart"))
                writer.uint32(/* id 4, wireType 0 =*/32).uint64(message.timeStart);
            if (message.timeEnd != null && Object.hasOwnProperty.call(message, "timeEnd"))
                writer.uint32(/* id 5, wireType 0 =*/40).uint64(message.timeEnd);
            if (message.offset != null && Object.hasOwnProperty.call(message, "offset"))
                writer.uint32(/* id 6, wireType 0 =*/48).uint64(message.offset);
            if (message.length != null && Object.hasOwnProperty.call(message, "length"))
                writer.uint32(/* id 7, wireType 0 =*/56).uint32(message.length);
            if (message.featureCount != null && Object.hasOwnProperty.call(message, "featureCount"))
                writer.uint32(/* id 8, wireType 0 =*/64).uint32(message.featureCount);
            if (message.compression != null && Object.hasOwnProperty.call(message, "compression"))
                writer.uint32(/* id 9, wireType 0 =*/72).int32(message.compression);
            if (message.uncompressedSize != null && Object.hasOwnProperty.call(message, "uncompressedSize"))
                writer.uint32(/* id 10, wireType 0 =*/80).uint32(message.uncompressedSize);
            return writer;
        };

        /**
         * Encodes the specified TileEntry message, length delimited. Does not implicitly {@link stt.TileEntry.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.TileEntry
         * @static
         * @param {stt.ITileEntry} message TileEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TileEntry.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a TileEntry message from the specified reader or buffer.
         * @function decode
         * @memberof stt.TileEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.TileEntry} TileEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TileEntry.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.TileEntry();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.zoom = reader.uint32();
                        break;
                    }
                case 2: {
                        message.x = reader.uint32();
                        break;
                    }
                case 3: {
                        message.y = reader.uint32();
                        break;
                    }
                case 4: {
                        message.timeStart = reader.uint64();
                        break;
                    }
                case 5: {
                        message.timeEnd = reader.uint64();
                        break;
                    }
                case 6: {
                        message.offset = reader.uint64();
                        break;
                    }
                case 7: {
                        message.length = reader.uint32();
                        break;
                    }
                case 8: {
                        message.featureCount = reader.uint32();
                        break;
                    }
                case 9: {
                        message.compression = reader.int32();
                        break;
                    }
                case 10: {
                        message.uncompressedSize = reader.uint32();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a TileEntry message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.TileEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.TileEntry} TileEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TileEntry.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a TileEntry message.
         * @function verify
         * @memberof stt.TileEntry
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        TileEntry.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.zoom != null && message.hasOwnProperty("zoom"))
                if (!$util.isInteger(message.zoom))
                    return "zoom: integer expected";
            if (message.x != null && message.hasOwnProperty("x"))
                if (!$util.isInteger(message.x))
                    return "x: integer expected";
            if (message.y != null && message.hasOwnProperty("y"))
                if (!$util.isInteger(message.y))
                    return "y: integer expected";
            if (message.timeStart != null && message.hasOwnProperty("timeStart"))
                if (!$util.isInteger(message.timeStart) && !(message.timeStart && $util.isInteger(message.timeStart.low) && $util.isInteger(message.timeStart.high)))
                    return "timeStart: integer|Long expected";
            if (message.timeEnd != null && message.hasOwnProperty("timeEnd"))
                if (!$util.isInteger(message.timeEnd) && !(message.timeEnd && $util.isInteger(message.timeEnd.low) && $util.isInteger(message.timeEnd.high)))
                    return "timeEnd: integer|Long expected";
            if (message.offset != null && message.hasOwnProperty("offset"))
                if (!$util.isInteger(message.offset) && !(message.offset && $util.isInteger(message.offset.low) && $util.isInteger(message.offset.high)))
                    return "offset: integer|Long expected";
            if (message.length != null && message.hasOwnProperty("length"))
                if (!$util.isInteger(message.length))
                    return "length: integer expected";
            if (message.featureCount != null && message.hasOwnProperty("featureCount"))
                if (!$util.isInteger(message.featureCount))
                    return "featureCount: integer expected";
            if (message.compression != null && message.hasOwnProperty("compression"))
                switch (message.compression) {
                default:
                    return "compression: enum value expected";
                case 0:
                case 1:
                case 2:
                    break;
                }
            if (message.uncompressedSize != null && message.hasOwnProperty("uncompressedSize"))
                if (!$util.isInteger(message.uncompressedSize))
                    return "uncompressedSize: integer expected";
            return null;
        };

        /**
         * Creates a TileEntry message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.TileEntry
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.TileEntry} TileEntry
         */
        TileEntry.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.TileEntry)
                return object;
            let message = new $root.stt.TileEntry();
            if (object.zoom != null)
                message.zoom = object.zoom >>> 0;
            if (object.x != null)
                message.x = object.x >>> 0;
            if (object.y != null)
                message.y = object.y >>> 0;
            if (object.timeStart != null)
                if ($util.Long)
                    (message.timeStart = $util.Long.fromValue(object.timeStart)).unsigned = true;
                else if (typeof object.timeStart === "string")
                    message.timeStart = parseInt(object.timeStart, 10);
                else if (typeof object.timeStart === "number")
                    message.timeStart = object.timeStart;
                else if (typeof object.timeStart === "object")
                    message.timeStart = new $util.LongBits(object.timeStart.low >>> 0, object.timeStart.high >>> 0).toNumber(true);
            if (object.timeEnd != null)
                if ($util.Long)
                    (message.timeEnd = $util.Long.fromValue(object.timeEnd)).unsigned = true;
                else if (typeof object.timeEnd === "string")
                    message.timeEnd = parseInt(object.timeEnd, 10);
                else if (typeof object.timeEnd === "number")
                    message.timeEnd = object.timeEnd;
                else if (typeof object.timeEnd === "object")
                    message.timeEnd = new $util.LongBits(object.timeEnd.low >>> 0, object.timeEnd.high >>> 0).toNumber(true);
            if (object.offset != null)
                if ($util.Long)
                    (message.offset = $util.Long.fromValue(object.offset)).unsigned = true;
                else if (typeof object.offset === "string")
                    message.offset = parseInt(object.offset, 10);
                else if (typeof object.offset === "number")
                    message.offset = object.offset;
                else if (typeof object.offset === "object")
                    message.offset = new $util.LongBits(object.offset.low >>> 0, object.offset.high >>> 0).toNumber(true);
            if (object.length != null)
                message.length = object.length >>> 0;
            if (object.featureCount != null)
                message.featureCount = object.featureCount >>> 0;
            switch (object.compression) {
            default:
                if (typeof object.compression === "number") {
                    message.compression = object.compression;
                    break;
                }
                break;
            case "NONE":
            case 0:
                message.compression = 0;
                break;
            case "GZIP":
            case 1:
                message.compression = 1;
                break;
            case "BROTLI":
            case 2:
                message.compression = 2;
                break;
            }
            if (object.uncompressedSize != null)
                message.uncompressedSize = object.uncompressedSize >>> 0;
            return message;
        };

        /**
         * Creates a plain object from a TileEntry message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.TileEntry
         * @static
         * @param {stt.TileEntry} message TileEntry
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        TileEntry.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.zoom = 0;
                object.x = 0;
                object.y = 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.timeStart = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.timeStart = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.timeEnd = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.timeEnd = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.offset = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.offset = options.longs === String ? "0" : 0;
                object.length = 0;
                object.featureCount = 0;
                object.compression = options.enums === String ? "NONE" : 0;
                object.uncompressedSize = 0;
            }
            if (message.zoom != null && message.hasOwnProperty("zoom"))
                object.zoom = message.zoom;
            if (message.x != null && message.hasOwnProperty("x"))
                object.x = message.x;
            if (message.y != null && message.hasOwnProperty("y"))
                object.y = message.y;
            if (message.timeStart != null && message.hasOwnProperty("timeStart"))
                if (typeof message.timeStart === "number")
                    object.timeStart = options.longs === String ? String(message.timeStart) : message.timeStart;
                else
                    object.timeStart = options.longs === String ? $util.Long.prototype.toString.call(message.timeStart) : options.longs === Number ? new $util.LongBits(message.timeStart.low >>> 0, message.timeStart.high >>> 0).toNumber(true) : message.timeStart;
            if (message.timeEnd != null && message.hasOwnProperty("timeEnd"))
                if (typeof message.timeEnd === "number")
                    object.timeEnd = options.longs === String ? String(message.timeEnd) : message.timeEnd;
                else
                    object.timeEnd = options.longs === String ? $util.Long.prototype.toString.call(message.timeEnd) : options.longs === Number ? new $util.LongBits(message.timeEnd.low >>> 0, message.timeEnd.high >>> 0).toNumber(true) : message.timeEnd;
            if (message.offset != null && message.hasOwnProperty("offset"))
                if (typeof message.offset === "number")
                    object.offset = options.longs === String ? String(message.offset) : message.offset;
                else
                    object.offset = options.longs === String ? $util.Long.prototype.toString.call(message.offset) : options.longs === Number ? new $util.LongBits(message.offset.low >>> 0, message.offset.high >>> 0).toNumber(true) : message.offset;
            if (message.length != null && message.hasOwnProperty("length"))
                object.length = message.length;
            if (message.featureCount != null && message.hasOwnProperty("featureCount"))
                object.featureCount = message.featureCount;
            if (message.compression != null && message.hasOwnProperty("compression"))
                object.compression = options.enums === String ? $root.stt.TileEntry.Compression[message.compression] === undefined ? message.compression : $root.stt.TileEntry.Compression[message.compression] : message.compression;
            if (message.uncompressedSize != null && message.hasOwnProperty("uncompressedSize"))
                object.uncompressedSize = message.uncompressedSize;
            return object;
        };

        /**
         * Converts this TileEntry to JSON.
         * @function toJSON
         * @memberof stt.TileEntry
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        TileEntry.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for TileEntry
         * @function getTypeUrl
         * @memberof stt.TileEntry
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        TileEntry.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.TileEntry";
        };

        /**
         * Compression enum.
         * @name stt.TileEntry.Compression
         * @enum {number}
         * @property {number} NONE=0 NONE value
         * @property {number} GZIP=1 GZIP value
         * @property {number} BROTLI=2 BROTLI value
         */
        TileEntry.Compression = (function() {
            const valuesById = {}, values = Object.create(valuesById);
            values[valuesById[0] = "NONE"] = 0;
            values[valuesById[1] = "GZIP"] = 1;
            values[valuesById[2] = "BROTLI"] = 2;
            return values;
        })();

        return TileEntry;
    })();

    stt.SpatialIndex = (function() {

        /**
         * Properties of a SpatialIndex.
         * @memberof stt
         * @interface ISpatialIndex
         * @property {Array.<number|Long>|null} [hilbertIds] SpatialIndex hilbertIds
         * @property {Array.<number>|null} [tileIndices] SpatialIndex tileIndices
         * @property {Array.<number>|null} [zoomOffsets] SpatialIndex zoomOffsets
         */

        /**
         * Constructs a new SpatialIndex.
         * @memberof stt
         * @classdesc Represents a SpatialIndex.
         * @implements ISpatialIndex
         * @constructor
         * @param {stt.ISpatialIndex=} [properties] Properties to set
         */
        function SpatialIndex(properties) {
            this.hilbertIds = [];
            this.tileIndices = [];
            this.zoomOffsets = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * SpatialIndex hilbertIds.
         * @member {Array.<number|Long>} hilbertIds
         * @memberof stt.SpatialIndex
         * @instance
         */
        SpatialIndex.prototype.hilbertIds = $util.emptyArray;

        /**
         * SpatialIndex tileIndices.
         * @member {Array.<number>} tileIndices
         * @memberof stt.SpatialIndex
         * @instance
         */
        SpatialIndex.prototype.tileIndices = $util.emptyArray;

        /**
         * SpatialIndex zoomOffsets.
         * @member {Array.<number>} zoomOffsets
         * @memberof stt.SpatialIndex
         * @instance
         */
        SpatialIndex.prototype.zoomOffsets = $util.emptyArray;

        /**
         * Creates a new SpatialIndex instance using the specified properties.
         * @function create
         * @memberof stt.SpatialIndex
         * @static
         * @param {stt.ISpatialIndex=} [properties] Properties to set
         * @returns {stt.SpatialIndex} SpatialIndex instance
         */
        SpatialIndex.create = function create(properties) {
            return new SpatialIndex(properties);
        };

        /**
         * Encodes the specified SpatialIndex message. Does not implicitly {@link stt.SpatialIndex.verify|verify} messages.
         * @function encode
         * @memberof stt.SpatialIndex
         * @static
         * @param {stt.ISpatialIndex} message SpatialIndex message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SpatialIndex.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.hilbertIds != null && message.hilbertIds.length) {
                writer.uint32(/* id 1, wireType 2 =*/10).fork();
                for (let i = 0; i < message.hilbertIds.length; ++i)
                    writer.uint64(message.hilbertIds[i]);
                writer.ldelim();
            }
            if (message.tileIndices != null && message.tileIndices.length) {
                writer.uint32(/* id 2, wireType 2 =*/18).fork();
                for (let i = 0; i < message.tileIndices.length; ++i)
                    writer.uint32(message.tileIndices[i]);
                writer.ldelim();
            }
            if (message.zoomOffsets != null && message.zoomOffsets.length) {
                writer.uint32(/* id 3, wireType 2 =*/26).fork();
                for (let i = 0; i < message.zoomOffsets.length; ++i)
                    writer.uint32(message.zoomOffsets[i]);
                writer.ldelim();
            }
            return writer;
        };

        /**
         * Encodes the specified SpatialIndex message, length delimited. Does not implicitly {@link stt.SpatialIndex.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.SpatialIndex
         * @static
         * @param {stt.ISpatialIndex} message SpatialIndex message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SpatialIndex.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a SpatialIndex message from the specified reader or buffer.
         * @function decode
         * @memberof stt.SpatialIndex
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.SpatialIndex} SpatialIndex
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SpatialIndex.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.SpatialIndex();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        if (!(message.hilbertIds && message.hilbertIds.length))
                            message.hilbertIds = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.hilbertIds.push(reader.uint64());
                        } else
                            message.hilbertIds.push(reader.uint64());
                        break;
                    }
                case 2: {
                        if (!(message.tileIndices && message.tileIndices.length))
                            message.tileIndices = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.tileIndices.push(reader.uint32());
                        } else
                            message.tileIndices.push(reader.uint32());
                        break;
                    }
                case 3: {
                        if (!(message.zoomOffsets && message.zoomOffsets.length))
                            message.zoomOffsets = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.zoomOffsets.push(reader.uint32());
                        } else
                            message.zoomOffsets.push(reader.uint32());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a SpatialIndex message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.SpatialIndex
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.SpatialIndex} SpatialIndex
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SpatialIndex.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a SpatialIndex message.
         * @function verify
         * @memberof stt.SpatialIndex
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        SpatialIndex.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.hilbertIds != null && message.hasOwnProperty("hilbertIds")) {
                if (!Array.isArray(message.hilbertIds))
                    return "hilbertIds: array expected";
                for (let i = 0; i < message.hilbertIds.length; ++i)
                    if (!$util.isInteger(message.hilbertIds[i]) && !(message.hilbertIds[i] && $util.isInteger(message.hilbertIds[i].low) && $util.isInteger(message.hilbertIds[i].high)))
                        return "hilbertIds: integer|Long[] expected";
            }
            if (message.tileIndices != null && message.hasOwnProperty("tileIndices")) {
                if (!Array.isArray(message.tileIndices))
                    return "tileIndices: array expected";
                for (let i = 0; i < message.tileIndices.length; ++i)
                    if (!$util.isInteger(message.tileIndices[i]))
                        return "tileIndices: integer[] expected";
            }
            if (message.zoomOffsets != null && message.hasOwnProperty("zoomOffsets")) {
                if (!Array.isArray(message.zoomOffsets))
                    return "zoomOffsets: array expected";
                for (let i = 0; i < message.zoomOffsets.length; ++i)
                    if (!$util.isInteger(message.zoomOffsets[i]))
                        return "zoomOffsets: integer[] expected";
            }
            return null;
        };

        /**
         * Creates a SpatialIndex message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.SpatialIndex
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.SpatialIndex} SpatialIndex
         */
        SpatialIndex.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.SpatialIndex)
                return object;
            let message = new $root.stt.SpatialIndex();
            if (object.hilbertIds) {
                if (!Array.isArray(object.hilbertIds))
                    throw TypeError(".stt.SpatialIndex.hilbertIds: array expected");
                message.hilbertIds = [];
                for (let i = 0; i < object.hilbertIds.length; ++i)
                    if ($util.Long)
                        (message.hilbertIds[i] = $util.Long.fromValue(object.hilbertIds[i])).unsigned = true;
                    else if (typeof object.hilbertIds[i] === "string")
                        message.hilbertIds[i] = parseInt(object.hilbertIds[i], 10);
                    else if (typeof object.hilbertIds[i] === "number")
                        message.hilbertIds[i] = object.hilbertIds[i];
                    else if (typeof object.hilbertIds[i] === "object")
                        message.hilbertIds[i] = new $util.LongBits(object.hilbertIds[i].low >>> 0, object.hilbertIds[i].high >>> 0).toNumber(true);
            }
            if (object.tileIndices) {
                if (!Array.isArray(object.tileIndices))
                    throw TypeError(".stt.SpatialIndex.tileIndices: array expected");
                message.tileIndices = [];
                for (let i = 0; i < object.tileIndices.length; ++i)
                    message.tileIndices[i] = object.tileIndices[i] >>> 0;
            }
            if (object.zoomOffsets) {
                if (!Array.isArray(object.zoomOffsets))
                    throw TypeError(".stt.SpatialIndex.zoomOffsets: array expected");
                message.zoomOffsets = [];
                for (let i = 0; i < object.zoomOffsets.length; ++i)
                    message.zoomOffsets[i] = object.zoomOffsets[i] >>> 0;
            }
            return message;
        };

        /**
         * Creates a plain object from a SpatialIndex message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.SpatialIndex
         * @static
         * @param {stt.SpatialIndex} message SpatialIndex
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        SpatialIndex.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults) {
                object.hilbertIds = [];
                object.tileIndices = [];
                object.zoomOffsets = [];
            }
            if (message.hilbertIds && message.hilbertIds.length) {
                object.hilbertIds = [];
                for (let j = 0; j < message.hilbertIds.length; ++j)
                    if (typeof message.hilbertIds[j] === "number")
                        object.hilbertIds[j] = options.longs === String ? String(message.hilbertIds[j]) : message.hilbertIds[j];
                    else
                        object.hilbertIds[j] = options.longs === String ? $util.Long.prototype.toString.call(message.hilbertIds[j]) : options.longs === Number ? new $util.LongBits(message.hilbertIds[j].low >>> 0, message.hilbertIds[j].high >>> 0).toNumber(true) : message.hilbertIds[j];
            }
            if (message.tileIndices && message.tileIndices.length) {
                object.tileIndices = [];
                for (let j = 0; j < message.tileIndices.length; ++j)
                    object.tileIndices[j] = message.tileIndices[j];
            }
            if (message.zoomOffsets && message.zoomOffsets.length) {
                object.zoomOffsets = [];
                for (let j = 0; j < message.zoomOffsets.length; ++j)
                    object.zoomOffsets[j] = message.zoomOffsets[j];
            }
            return object;
        };

        /**
         * Converts this SpatialIndex to JSON.
         * @function toJSON
         * @memberof stt.SpatialIndex
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        SpatialIndex.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for SpatialIndex
         * @function getTypeUrl
         * @memberof stt.SpatialIndex
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        SpatialIndex.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.SpatialIndex";
        };

        return SpatialIndex;
    })();

    stt.TemporalIndex = (function() {

        /**
         * Properties of a TemporalIndex.
         * @memberof stt
         * @interface ITemporalIndex
         * @property {Array.<number|Long>|null} [timestamps] TemporalIndex timestamps
         * @property {Array.<number>|null} [tileRefOffsets] TemporalIndex tileRefOffsets
         * @property {Array.<number>|null} [tileRefs] TemporalIndex tileRefs
         */

        /**
         * Constructs a new TemporalIndex.
         * @memberof stt
         * @classdesc Represents a TemporalIndex.
         * @implements ITemporalIndex
         * @constructor
         * @param {stt.ITemporalIndex=} [properties] Properties to set
         */
        function TemporalIndex(properties) {
            this.timestamps = [];
            this.tileRefOffsets = [];
            this.tileRefs = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * TemporalIndex timestamps.
         * @member {Array.<number|Long>} timestamps
         * @memberof stt.TemporalIndex
         * @instance
         */
        TemporalIndex.prototype.timestamps = $util.emptyArray;

        /**
         * TemporalIndex tileRefOffsets.
         * @member {Array.<number>} tileRefOffsets
         * @memberof stt.TemporalIndex
         * @instance
         */
        TemporalIndex.prototype.tileRefOffsets = $util.emptyArray;

        /**
         * TemporalIndex tileRefs.
         * @member {Array.<number>} tileRefs
         * @memberof stt.TemporalIndex
         * @instance
         */
        TemporalIndex.prototype.tileRefs = $util.emptyArray;

        /**
         * Creates a new TemporalIndex instance using the specified properties.
         * @function create
         * @memberof stt.TemporalIndex
         * @static
         * @param {stt.ITemporalIndex=} [properties] Properties to set
         * @returns {stt.TemporalIndex} TemporalIndex instance
         */
        TemporalIndex.create = function create(properties) {
            return new TemporalIndex(properties);
        };

        /**
         * Encodes the specified TemporalIndex message. Does not implicitly {@link stt.TemporalIndex.verify|verify} messages.
         * @function encode
         * @memberof stt.TemporalIndex
         * @static
         * @param {stt.ITemporalIndex} message TemporalIndex message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TemporalIndex.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.timestamps != null && message.timestamps.length) {
                writer.uint32(/* id 1, wireType 2 =*/10).fork();
                for (let i = 0; i < message.timestamps.length; ++i)
                    writer.uint64(message.timestamps[i]);
                writer.ldelim();
            }
            if (message.tileRefOffsets != null && message.tileRefOffsets.length) {
                writer.uint32(/* id 2, wireType 2 =*/18).fork();
                for (let i = 0; i < message.tileRefOffsets.length; ++i)
                    writer.uint32(message.tileRefOffsets[i]);
                writer.ldelim();
            }
            if (message.tileRefs != null && message.tileRefs.length) {
                writer.uint32(/* id 3, wireType 2 =*/26).fork();
                for (let i = 0; i < message.tileRefs.length; ++i)
                    writer.uint32(message.tileRefs[i]);
                writer.ldelim();
            }
            return writer;
        };

        /**
         * Encodes the specified TemporalIndex message, length delimited. Does not implicitly {@link stt.TemporalIndex.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.TemporalIndex
         * @static
         * @param {stt.ITemporalIndex} message TemporalIndex message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TemporalIndex.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a TemporalIndex message from the specified reader or buffer.
         * @function decode
         * @memberof stt.TemporalIndex
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.TemporalIndex} TemporalIndex
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TemporalIndex.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.TemporalIndex();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        if (!(message.timestamps && message.timestamps.length))
                            message.timestamps = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.timestamps.push(reader.uint64());
                        } else
                            message.timestamps.push(reader.uint64());
                        break;
                    }
                case 2: {
                        if (!(message.tileRefOffsets && message.tileRefOffsets.length))
                            message.tileRefOffsets = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.tileRefOffsets.push(reader.uint32());
                        } else
                            message.tileRefOffsets.push(reader.uint32());
                        break;
                    }
                case 3: {
                        if (!(message.tileRefs && message.tileRefs.length))
                            message.tileRefs = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.tileRefs.push(reader.uint32());
                        } else
                            message.tileRefs.push(reader.uint32());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a TemporalIndex message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.TemporalIndex
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.TemporalIndex} TemporalIndex
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TemporalIndex.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a TemporalIndex message.
         * @function verify
         * @memberof stt.TemporalIndex
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        TemporalIndex.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.timestamps != null && message.hasOwnProperty("timestamps")) {
                if (!Array.isArray(message.timestamps))
                    return "timestamps: array expected";
                for (let i = 0; i < message.timestamps.length; ++i)
                    if (!$util.isInteger(message.timestamps[i]) && !(message.timestamps[i] && $util.isInteger(message.timestamps[i].low) && $util.isInteger(message.timestamps[i].high)))
                        return "timestamps: integer|Long[] expected";
            }
            if (message.tileRefOffsets != null && message.hasOwnProperty("tileRefOffsets")) {
                if (!Array.isArray(message.tileRefOffsets))
                    return "tileRefOffsets: array expected";
                for (let i = 0; i < message.tileRefOffsets.length; ++i)
                    if (!$util.isInteger(message.tileRefOffsets[i]))
                        return "tileRefOffsets: integer[] expected";
            }
            if (message.tileRefs != null && message.hasOwnProperty("tileRefs")) {
                if (!Array.isArray(message.tileRefs))
                    return "tileRefs: array expected";
                for (let i = 0; i < message.tileRefs.length; ++i)
                    if (!$util.isInteger(message.tileRefs[i]))
                        return "tileRefs: integer[] expected";
            }
            return null;
        };

        /**
         * Creates a TemporalIndex message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.TemporalIndex
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.TemporalIndex} TemporalIndex
         */
        TemporalIndex.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.TemporalIndex)
                return object;
            let message = new $root.stt.TemporalIndex();
            if (object.timestamps) {
                if (!Array.isArray(object.timestamps))
                    throw TypeError(".stt.TemporalIndex.timestamps: array expected");
                message.timestamps = [];
                for (let i = 0; i < object.timestamps.length; ++i)
                    if ($util.Long)
                        (message.timestamps[i] = $util.Long.fromValue(object.timestamps[i])).unsigned = true;
                    else if (typeof object.timestamps[i] === "string")
                        message.timestamps[i] = parseInt(object.timestamps[i], 10);
                    else if (typeof object.timestamps[i] === "number")
                        message.timestamps[i] = object.timestamps[i];
                    else if (typeof object.timestamps[i] === "object")
                        message.timestamps[i] = new $util.LongBits(object.timestamps[i].low >>> 0, object.timestamps[i].high >>> 0).toNumber(true);
            }
            if (object.tileRefOffsets) {
                if (!Array.isArray(object.tileRefOffsets))
                    throw TypeError(".stt.TemporalIndex.tileRefOffsets: array expected");
                message.tileRefOffsets = [];
                for (let i = 0; i < object.tileRefOffsets.length; ++i)
                    message.tileRefOffsets[i] = object.tileRefOffsets[i] >>> 0;
            }
            if (object.tileRefs) {
                if (!Array.isArray(object.tileRefs))
                    throw TypeError(".stt.TemporalIndex.tileRefs: array expected");
                message.tileRefs = [];
                for (let i = 0; i < object.tileRefs.length; ++i)
                    message.tileRefs[i] = object.tileRefs[i] >>> 0;
            }
            return message;
        };

        /**
         * Creates a plain object from a TemporalIndex message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.TemporalIndex
         * @static
         * @param {stt.TemporalIndex} message TemporalIndex
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        TemporalIndex.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults) {
                object.timestamps = [];
                object.tileRefOffsets = [];
                object.tileRefs = [];
            }
            if (message.timestamps && message.timestamps.length) {
                object.timestamps = [];
                for (let j = 0; j < message.timestamps.length; ++j)
                    if (typeof message.timestamps[j] === "number")
                        object.timestamps[j] = options.longs === String ? String(message.timestamps[j]) : message.timestamps[j];
                    else
                        object.timestamps[j] = options.longs === String ? $util.Long.prototype.toString.call(message.timestamps[j]) : options.longs === Number ? new $util.LongBits(message.timestamps[j].low >>> 0, message.timestamps[j].high >>> 0).toNumber(true) : message.timestamps[j];
            }
            if (message.tileRefOffsets && message.tileRefOffsets.length) {
                object.tileRefOffsets = [];
                for (let j = 0; j < message.tileRefOffsets.length; ++j)
                    object.tileRefOffsets[j] = message.tileRefOffsets[j];
            }
            if (message.tileRefs && message.tileRefs.length) {
                object.tileRefs = [];
                for (let j = 0; j < message.tileRefs.length; ++j)
                    object.tileRefs[j] = message.tileRefs[j];
            }
            return object;
        };

        /**
         * Converts this TemporalIndex to JSON.
         * @function toJSON
         * @memberof stt.TemporalIndex
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        TemporalIndex.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for TemporalIndex
         * @function getTypeUrl
         * @memberof stt.TemporalIndex
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        TemporalIndex.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.TemporalIndex";
        };

        return TemporalIndex;
    })();

    stt.Metadata = (function() {

        /**
         * Properties of a Metadata.
         * @memberof stt
         * @interface IMetadata
         * @property {number|null} [version] Metadata version
         * @property {string|null} [name] Metadata name
         * @property {string|null} [description] Metadata description
         * @property {string|null} [attribution] Metadata attribution
         * @property {stt.IBoundingBox|null} [bounds] Metadata bounds
         * @property {stt.ITimeRange|null} [timeRange] Metadata timeRange
         * @property {number|null} [minZoom] Metadata minZoom
         * @property {number|null} [maxZoom] Metadata maxZoom
         * @property {Array.<stt.ILayerInfo>|null} [layers] Metadata layers
         * @property {stt.IGenerationInfo|null} [generation] Metadata generation
         * @property {stt.IStatistics|null} [stats] Metadata stats
         */

        /**
         * Constructs a new Metadata.
         * @memberof stt
         * @classdesc Represents a Metadata.
         * @implements IMetadata
         * @constructor
         * @param {stt.IMetadata=} [properties] Properties to set
         */
        function Metadata(properties) {
            this.layers = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Metadata version.
         * @member {number} version
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.version = 0;

        /**
         * Metadata name.
         * @member {string} name
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.name = "";

        /**
         * Metadata description.
         * @member {string} description
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.description = "";

        /**
         * Metadata attribution.
         * @member {string} attribution
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.attribution = "";

        /**
         * Metadata bounds.
         * @member {stt.IBoundingBox|null|undefined} bounds
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.bounds = null;

        /**
         * Metadata timeRange.
         * @member {stt.ITimeRange|null|undefined} timeRange
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.timeRange = null;

        /**
         * Metadata minZoom.
         * @member {number} minZoom
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.minZoom = 0;

        /**
         * Metadata maxZoom.
         * @member {number} maxZoom
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.maxZoom = 0;

        /**
         * Metadata layers.
         * @member {Array.<stt.ILayerInfo>} layers
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.layers = $util.emptyArray;

        /**
         * Metadata generation.
         * @member {stt.IGenerationInfo|null|undefined} generation
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.generation = null;

        /**
         * Metadata stats.
         * @member {stt.IStatistics|null|undefined} stats
         * @memberof stt.Metadata
         * @instance
         */
        Metadata.prototype.stats = null;

        /**
         * Creates a new Metadata instance using the specified properties.
         * @function create
         * @memberof stt.Metadata
         * @static
         * @param {stt.IMetadata=} [properties] Properties to set
         * @returns {stt.Metadata} Metadata instance
         */
        Metadata.create = function create(properties) {
            return new Metadata(properties);
        };

        /**
         * Encodes the specified Metadata message. Does not implicitly {@link stt.Metadata.verify|verify} messages.
         * @function encode
         * @memberof stt.Metadata
         * @static
         * @param {stt.IMetadata} message Metadata message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Metadata.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.version != null && Object.hasOwnProperty.call(message, "version"))
                writer.uint32(/* id 1, wireType 0 =*/8).uint32(message.version);
            if (message.name != null && Object.hasOwnProperty.call(message, "name"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.name);
            if (message.description != null && Object.hasOwnProperty.call(message, "description"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.description);
            if (message.attribution != null && Object.hasOwnProperty.call(message, "attribution"))
                writer.uint32(/* id 4, wireType 2 =*/34).string(message.attribution);
            if (message.bounds != null && Object.hasOwnProperty.call(message, "bounds"))
                $root.stt.BoundingBox.encode(message.bounds, writer.uint32(/* id 5, wireType 2 =*/42).fork()).ldelim();
            if (message.timeRange != null && Object.hasOwnProperty.call(message, "timeRange"))
                $root.stt.TimeRange.encode(message.timeRange, writer.uint32(/* id 6, wireType 2 =*/50).fork()).ldelim();
            if (message.minZoom != null && Object.hasOwnProperty.call(message, "minZoom"))
                writer.uint32(/* id 7, wireType 0 =*/56).uint32(message.minZoom);
            if (message.maxZoom != null && Object.hasOwnProperty.call(message, "maxZoom"))
                writer.uint32(/* id 8, wireType 0 =*/64).uint32(message.maxZoom);
            if (message.layers != null && message.layers.length)
                for (let i = 0; i < message.layers.length; ++i)
                    $root.stt.LayerInfo.encode(message.layers[i], writer.uint32(/* id 9, wireType 2 =*/74).fork()).ldelim();
            if (message.generation != null && Object.hasOwnProperty.call(message, "generation"))
                $root.stt.GenerationInfo.encode(message.generation, writer.uint32(/* id 10, wireType 2 =*/82).fork()).ldelim();
            if (message.stats != null && Object.hasOwnProperty.call(message, "stats"))
                $root.stt.Statistics.encode(message.stats, writer.uint32(/* id 11, wireType 2 =*/90).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified Metadata message, length delimited. Does not implicitly {@link stt.Metadata.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.Metadata
         * @static
         * @param {stt.IMetadata} message Metadata message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Metadata.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a Metadata message from the specified reader or buffer.
         * @function decode
         * @memberof stt.Metadata
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.Metadata} Metadata
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Metadata.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.Metadata();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.version = reader.uint32();
                        break;
                    }
                case 2: {
                        message.name = reader.string();
                        break;
                    }
                case 3: {
                        message.description = reader.string();
                        break;
                    }
                case 4: {
                        message.attribution = reader.string();
                        break;
                    }
                case 5: {
                        message.bounds = $root.stt.BoundingBox.decode(reader, reader.uint32());
                        break;
                    }
                case 6: {
                        message.timeRange = $root.stt.TimeRange.decode(reader, reader.uint32());
                        break;
                    }
                case 7: {
                        message.minZoom = reader.uint32();
                        break;
                    }
                case 8: {
                        message.maxZoom = reader.uint32();
                        break;
                    }
                case 9: {
                        if (!(message.layers && message.layers.length))
                            message.layers = [];
                        message.layers.push($root.stt.LayerInfo.decode(reader, reader.uint32()));
                        break;
                    }
                case 10: {
                        message.generation = $root.stt.GenerationInfo.decode(reader, reader.uint32());
                        break;
                    }
                case 11: {
                        message.stats = $root.stt.Statistics.decode(reader, reader.uint32());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a Metadata message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.Metadata
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.Metadata} Metadata
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Metadata.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Metadata message.
         * @function verify
         * @memberof stt.Metadata
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Metadata.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.version != null && message.hasOwnProperty("version"))
                if (!$util.isInteger(message.version))
                    return "version: integer expected";
            if (message.name != null && message.hasOwnProperty("name"))
                if (!$util.isString(message.name))
                    return "name: string expected";
            if (message.description != null && message.hasOwnProperty("description"))
                if (!$util.isString(message.description))
                    return "description: string expected";
            if (message.attribution != null && message.hasOwnProperty("attribution"))
                if (!$util.isString(message.attribution))
                    return "attribution: string expected";
            if (message.bounds != null && message.hasOwnProperty("bounds")) {
                let error = $root.stt.BoundingBox.verify(message.bounds);
                if (error)
                    return "bounds." + error;
            }
            if (message.timeRange != null && message.hasOwnProperty("timeRange")) {
                let error = $root.stt.TimeRange.verify(message.timeRange);
                if (error)
                    return "timeRange." + error;
            }
            if (message.minZoom != null && message.hasOwnProperty("minZoom"))
                if (!$util.isInteger(message.minZoom))
                    return "minZoom: integer expected";
            if (message.maxZoom != null && message.hasOwnProperty("maxZoom"))
                if (!$util.isInteger(message.maxZoom))
                    return "maxZoom: integer expected";
            if (message.layers != null && message.hasOwnProperty("layers")) {
                if (!Array.isArray(message.layers))
                    return "layers: array expected";
                for (let i = 0; i < message.layers.length; ++i) {
                    let error = $root.stt.LayerInfo.verify(message.layers[i]);
                    if (error)
                        return "layers." + error;
                }
            }
            if (message.generation != null && message.hasOwnProperty("generation")) {
                let error = $root.stt.GenerationInfo.verify(message.generation);
                if (error)
                    return "generation." + error;
            }
            if (message.stats != null && message.hasOwnProperty("stats")) {
                let error = $root.stt.Statistics.verify(message.stats);
                if (error)
                    return "stats." + error;
            }
            return null;
        };

        /**
         * Creates a Metadata message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.Metadata
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.Metadata} Metadata
         */
        Metadata.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.Metadata)
                return object;
            let message = new $root.stt.Metadata();
            if (object.version != null)
                message.version = object.version >>> 0;
            if (object.name != null)
                message.name = String(object.name);
            if (object.description != null)
                message.description = String(object.description);
            if (object.attribution != null)
                message.attribution = String(object.attribution);
            if (object.bounds != null) {
                if (typeof object.bounds !== "object")
                    throw TypeError(".stt.Metadata.bounds: object expected");
                message.bounds = $root.stt.BoundingBox.fromObject(object.bounds);
            }
            if (object.timeRange != null) {
                if (typeof object.timeRange !== "object")
                    throw TypeError(".stt.Metadata.timeRange: object expected");
                message.timeRange = $root.stt.TimeRange.fromObject(object.timeRange);
            }
            if (object.minZoom != null)
                message.minZoom = object.minZoom >>> 0;
            if (object.maxZoom != null)
                message.maxZoom = object.maxZoom >>> 0;
            if (object.layers) {
                if (!Array.isArray(object.layers))
                    throw TypeError(".stt.Metadata.layers: array expected");
                message.layers = [];
                for (let i = 0; i < object.layers.length; ++i) {
                    if (typeof object.layers[i] !== "object")
                        throw TypeError(".stt.Metadata.layers: object expected");
                    message.layers[i] = $root.stt.LayerInfo.fromObject(object.layers[i]);
                }
            }
            if (object.generation != null) {
                if (typeof object.generation !== "object")
                    throw TypeError(".stt.Metadata.generation: object expected");
                message.generation = $root.stt.GenerationInfo.fromObject(object.generation);
            }
            if (object.stats != null) {
                if (typeof object.stats !== "object")
                    throw TypeError(".stt.Metadata.stats: object expected");
                message.stats = $root.stt.Statistics.fromObject(object.stats);
            }
            return message;
        };

        /**
         * Creates a plain object from a Metadata message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.Metadata
         * @static
         * @param {stt.Metadata} message Metadata
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Metadata.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.layers = [];
            if (options.defaults) {
                object.version = 0;
                object.name = "";
                object.description = "";
                object.attribution = "";
                object.bounds = null;
                object.timeRange = null;
                object.minZoom = 0;
                object.maxZoom = 0;
                object.generation = null;
                object.stats = null;
            }
            if (message.version != null && message.hasOwnProperty("version"))
                object.version = message.version;
            if (message.name != null && message.hasOwnProperty("name"))
                object.name = message.name;
            if (message.description != null && message.hasOwnProperty("description"))
                object.description = message.description;
            if (message.attribution != null && message.hasOwnProperty("attribution"))
                object.attribution = message.attribution;
            if (message.bounds != null && message.hasOwnProperty("bounds"))
                object.bounds = $root.stt.BoundingBox.toObject(message.bounds, options);
            if (message.timeRange != null && message.hasOwnProperty("timeRange"))
                object.timeRange = $root.stt.TimeRange.toObject(message.timeRange, options);
            if (message.minZoom != null && message.hasOwnProperty("minZoom"))
                object.minZoom = message.minZoom;
            if (message.maxZoom != null && message.hasOwnProperty("maxZoom"))
                object.maxZoom = message.maxZoom;
            if (message.layers && message.layers.length) {
                object.layers = [];
                for (let j = 0; j < message.layers.length; ++j)
                    object.layers[j] = $root.stt.LayerInfo.toObject(message.layers[j], options);
            }
            if (message.generation != null && message.hasOwnProperty("generation"))
                object.generation = $root.stt.GenerationInfo.toObject(message.generation, options);
            if (message.stats != null && message.hasOwnProperty("stats"))
                object.stats = $root.stt.Statistics.toObject(message.stats, options);
            return object;
        };

        /**
         * Converts this Metadata to JSON.
         * @function toJSON
         * @memberof stt.Metadata
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Metadata.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for Metadata
         * @function getTypeUrl
         * @memberof stt.Metadata
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        Metadata.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.Metadata";
        };

        return Metadata;
    })();

    stt.BoundingBox = (function() {

        /**
         * Properties of a BoundingBox.
         * @memberof stt
         * @interface IBoundingBox
         * @property {number|null} [minLon] BoundingBox minLon
         * @property {number|null} [minLat] BoundingBox minLat
         * @property {number|null} [maxLon] BoundingBox maxLon
         * @property {number|null} [maxLat] BoundingBox maxLat
         */

        /**
         * Constructs a new BoundingBox.
         * @memberof stt
         * @classdesc Represents a BoundingBox.
         * @implements IBoundingBox
         * @constructor
         * @param {stt.IBoundingBox=} [properties] Properties to set
         */
        function BoundingBox(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * BoundingBox minLon.
         * @member {number} minLon
         * @memberof stt.BoundingBox
         * @instance
         */
        BoundingBox.prototype.minLon = 0;

        /**
         * BoundingBox minLat.
         * @member {number} minLat
         * @memberof stt.BoundingBox
         * @instance
         */
        BoundingBox.prototype.minLat = 0;

        /**
         * BoundingBox maxLon.
         * @member {number} maxLon
         * @memberof stt.BoundingBox
         * @instance
         */
        BoundingBox.prototype.maxLon = 0;

        /**
         * BoundingBox maxLat.
         * @member {number} maxLat
         * @memberof stt.BoundingBox
         * @instance
         */
        BoundingBox.prototype.maxLat = 0;

        /**
         * Creates a new BoundingBox instance using the specified properties.
         * @function create
         * @memberof stt.BoundingBox
         * @static
         * @param {stt.IBoundingBox=} [properties] Properties to set
         * @returns {stt.BoundingBox} BoundingBox instance
         */
        BoundingBox.create = function create(properties) {
            return new BoundingBox(properties);
        };

        /**
         * Encodes the specified BoundingBox message. Does not implicitly {@link stt.BoundingBox.verify|verify} messages.
         * @function encode
         * @memberof stt.BoundingBox
         * @static
         * @param {stt.IBoundingBox} message BoundingBox message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        BoundingBox.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.minLon != null && Object.hasOwnProperty.call(message, "minLon"))
                writer.uint32(/* id 1, wireType 1 =*/9).double(message.minLon);
            if (message.minLat != null && Object.hasOwnProperty.call(message, "minLat"))
                writer.uint32(/* id 2, wireType 1 =*/17).double(message.minLat);
            if (message.maxLon != null && Object.hasOwnProperty.call(message, "maxLon"))
                writer.uint32(/* id 3, wireType 1 =*/25).double(message.maxLon);
            if (message.maxLat != null && Object.hasOwnProperty.call(message, "maxLat"))
                writer.uint32(/* id 4, wireType 1 =*/33).double(message.maxLat);
            return writer;
        };

        /**
         * Encodes the specified BoundingBox message, length delimited. Does not implicitly {@link stt.BoundingBox.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.BoundingBox
         * @static
         * @param {stt.IBoundingBox} message BoundingBox message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        BoundingBox.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a BoundingBox message from the specified reader or buffer.
         * @function decode
         * @memberof stt.BoundingBox
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.BoundingBox} BoundingBox
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        BoundingBox.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.BoundingBox();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.minLon = reader.double();
                        break;
                    }
                case 2: {
                        message.minLat = reader.double();
                        break;
                    }
                case 3: {
                        message.maxLon = reader.double();
                        break;
                    }
                case 4: {
                        message.maxLat = reader.double();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a BoundingBox message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.BoundingBox
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.BoundingBox} BoundingBox
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        BoundingBox.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a BoundingBox message.
         * @function verify
         * @memberof stt.BoundingBox
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        BoundingBox.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.minLon != null && message.hasOwnProperty("minLon"))
                if (typeof message.minLon !== "number")
                    return "minLon: number expected";
            if (message.minLat != null && message.hasOwnProperty("minLat"))
                if (typeof message.minLat !== "number")
                    return "minLat: number expected";
            if (message.maxLon != null && message.hasOwnProperty("maxLon"))
                if (typeof message.maxLon !== "number")
                    return "maxLon: number expected";
            if (message.maxLat != null && message.hasOwnProperty("maxLat"))
                if (typeof message.maxLat !== "number")
                    return "maxLat: number expected";
            return null;
        };

        /**
         * Creates a BoundingBox message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.BoundingBox
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.BoundingBox} BoundingBox
         */
        BoundingBox.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.BoundingBox)
                return object;
            let message = new $root.stt.BoundingBox();
            if (object.minLon != null)
                message.minLon = Number(object.minLon);
            if (object.minLat != null)
                message.minLat = Number(object.minLat);
            if (object.maxLon != null)
                message.maxLon = Number(object.maxLon);
            if (object.maxLat != null)
                message.maxLat = Number(object.maxLat);
            return message;
        };

        /**
         * Creates a plain object from a BoundingBox message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.BoundingBox
         * @static
         * @param {stt.BoundingBox} message BoundingBox
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        BoundingBox.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.minLon = 0;
                object.minLat = 0;
                object.maxLon = 0;
                object.maxLat = 0;
            }
            if (message.minLon != null && message.hasOwnProperty("minLon"))
                object.minLon = options.json && !isFinite(message.minLon) ? String(message.minLon) : message.minLon;
            if (message.minLat != null && message.hasOwnProperty("minLat"))
                object.minLat = options.json && !isFinite(message.minLat) ? String(message.minLat) : message.minLat;
            if (message.maxLon != null && message.hasOwnProperty("maxLon"))
                object.maxLon = options.json && !isFinite(message.maxLon) ? String(message.maxLon) : message.maxLon;
            if (message.maxLat != null && message.hasOwnProperty("maxLat"))
                object.maxLat = options.json && !isFinite(message.maxLat) ? String(message.maxLat) : message.maxLat;
            return object;
        };

        /**
         * Converts this BoundingBox to JSON.
         * @function toJSON
         * @memberof stt.BoundingBox
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        BoundingBox.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for BoundingBox
         * @function getTypeUrl
         * @memberof stt.BoundingBox
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        BoundingBox.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.BoundingBox";
        };

        return BoundingBox;
    })();

    stt.TimeRange = (function() {

        /**
         * Properties of a TimeRange.
         * @memberof stt
         * @interface ITimeRange
         * @property {number|Long|null} [start] TimeRange start
         * @property {number|Long|null} [end] TimeRange end
         * @property {number|Long|null} [interval] TimeRange interval
         */

        /**
         * Constructs a new TimeRange.
         * @memberof stt
         * @classdesc Represents a TimeRange.
         * @implements ITimeRange
         * @constructor
         * @param {stt.ITimeRange=} [properties] Properties to set
         */
        function TimeRange(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * TimeRange start.
         * @member {number|Long} start
         * @memberof stt.TimeRange
         * @instance
         */
        TimeRange.prototype.start = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * TimeRange end.
         * @member {number|Long} end
         * @memberof stt.TimeRange
         * @instance
         */
        TimeRange.prototype.end = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * TimeRange interval.
         * @member {number|Long} interval
         * @memberof stt.TimeRange
         * @instance
         */
        TimeRange.prototype.interval = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * Creates a new TimeRange instance using the specified properties.
         * @function create
         * @memberof stt.TimeRange
         * @static
         * @param {stt.ITimeRange=} [properties] Properties to set
         * @returns {stt.TimeRange} TimeRange instance
         */
        TimeRange.create = function create(properties) {
            return new TimeRange(properties);
        };

        /**
         * Encodes the specified TimeRange message. Does not implicitly {@link stt.TimeRange.verify|verify} messages.
         * @function encode
         * @memberof stt.TimeRange
         * @static
         * @param {stt.ITimeRange} message TimeRange message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TimeRange.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.start != null && Object.hasOwnProperty.call(message, "start"))
                writer.uint32(/* id 1, wireType 0 =*/8).uint64(message.start);
            if (message.end != null && Object.hasOwnProperty.call(message, "end"))
                writer.uint32(/* id 2, wireType 0 =*/16).uint64(message.end);
            if (message.interval != null && Object.hasOwnProperty.call(message, "interval"))
                writer.uint32(/* id 3, wireType 0 =*/24).uint64(message.interval);
            return writer;
        };

        /**
         * Encodes the specified TimeRange message, length delimited. Does not implicitly {@link stt.TimeRange.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.TimeRange
         * @static
         * @param {stt.ITimeRange} message TimeRange message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TimeRange.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a TimeRange message from the specified reader or buffer.
         * @function decode
         * @memberof stt.TimeRange
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.TimeRange} TimeRange
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TimeRange.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.TimeRange();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.start = reader.uint64();
                        break;
                    }
                case 2: {
                        message.end = reader.uint64();
                        break;
                    }
                case 3: {
                        message.interval = reader.uint64();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a TimeRange message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.TimeRange
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.TimeRange} TimeRange
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TimeRange.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a TimeRange message.
         * @function verify
         * @memberof stt.TimeRange
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        TimeRange.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.start != null && message.hasOwnProperty("start"))
                if (!$util.isInteger(message.start) && !(message.start && $util.isInteger(message.start.low) && $util.isInteger(message.start.high)))
                    return "start: integer|Long expected";
            if (message.end != null && message.hasOwnProperty("end"))
                if (!$util.isInteger(message.end) && !(message.end && $util.isInteger(message.end.low) && $util.isInteger(message.end.high)))
                    return "end: integer|Long expected";
            if (message.interval != null && message.hasOwnProperty("interval"))
                if (!$util.isInteger(message.interval) && !(message.interval && $util.isInteger(message.interval.low) && $util.isInteger(message.interval.high)))
                    return "interval: integer|Long expected";
            return null;
        };

        /**
         * Creates a TimeRange message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.TimeRange
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.TimeRange} TimeRange
         */
        TimeRange.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.TimeRange)
                return object;
            let message = new $root.stt.TimeRange();
            if (object.start != null)
                if ($util.Long)
                    (message.start = $util.Long.fromValue(object.start)).unsigned = true;
                else if (typeof object.start === "string")
                    message.start = parseInt(object.start, 10);
                else if (typeof object.start === "number")
                    message.start = object.start;
                else if (typeof object.start === "object")
                    message.start = new $util.LongBits(object.start.low >>> 0, object.start.high >>> 0).toNumber(true);
            if (object.end != null)
                if ($util.Long)
                    (message.end = $util.Long.fromValue(object.end)).unsigned = true;
                else if (typeof object.end === "string")
                    message.end = parseInt(object.end, 10);
                else if (typeof object.end === "number")
                    message.end = object.end;
                else if (typeof object.end === "object")
                    message.end = new $util.LongBits(object.end.low >>> 0, object.end.high >>> 0).toNumber(true);
            if (object.interval != null)
                if ($util.Long)
                    (message.interval = $util.Long.fromValue(object.interval)).unsigned = true;
                else if (typeof object.interval === "string")
                    message.interval = parseInt(object.interval, 10);
                else if (typeof object.interval === "number")
                    message.interval = object.interval;
                else if (typeof object.interval === "object")
                    message.interval = new $util.LongBits(object.interval.low >>> 0, object.interval.high >>> 0).toNumber(true);
            return message;
        };

        /**
         * Creates a plain object from a TimeRange message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.TimeRange
         * @static
         * @param {stt.TimeRange} message TimeRange
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        TimeRange.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.start = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.start = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.end = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.end = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.interval = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.interval = options.longs === String ? "0" : 0;
            }
            if (message.start != null && message.hasOwnProperty("start"))
                if (typeof message.start === "number")
                    object.start = options.longs === String ? String(message.start) : message.start;
                else
                    object.start = options.longs === String ? $util.Long.prototype.toString.call(message.start) : options.longs === Number ? new $util.LongBits(message.start.low >>> 0, message.start.high >>> 0).toNumber(true) : message.start;
            if (message.end != null && message.hasOwnProperty("end"))
                if (typeof message.end === "number")
                    object.end = options.longs === String ? String(message.end) : message.end;
                else
                    object.end = options.longs === String ? $util.Long.prototype.toString.call(message.end) : options.longs === Number ? new $util.LongBits(message.end.low >>> 0, message.end.high >>> 0).toNumber(true) : message.end;
            if (message.interval != null && message.hasOwnProperty("interval"))
                if (typeof message.interval === "number")
                    object.interval = options.longs === String ? String(message.interval) : message.interval;
                else
                    object.interval = options.longs === String ? $util.Long.prototype.toString.call(message.interval) : options.longs === Number ? new $util.LongBits(message.interval.low >>> 0, message.interval.high >>> 0).toNumber(true) : message.interval;
            return object;
        };

        /**
         * Converts this TimeRange to JSON.
         * @function toJSON
         * @memberof stt.TimeRange
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        TimeRange.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for TimeRange
         * @function getTypeUrl
         * @memberof stt.TimeRange
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        TimeRange.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.TimeRange";
        };

        return TimeRange;
    })();

    stt.LayerInfo = (function() {

        /**
         * Properties of a LayerInfo.
         * @memberof stt
         * @interface ILayerInfo
         * @property {string|null} [name] LayerInfo name
         * @property {string|null} [description] LayerInfo description
         * @property {Array.<stt.IPropertyInfo>|null} [properties] LayerInfo properties
         * @property {Array.<string>|null} [geometryTypes] LayerInfo geometryTypes
         */

        /**
         * Constructs a new LayerInfo.
         * @memberof stt
         * @classdesc Represents a LayerInfo.
         * @implements ILayerInfo
         * @constructor
         * @param {stt.ILayerInfo=} [properties] Properties to set
         */
        function LayerInfo(properties) {
            this.properties = [];
            this.geometryTypes = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * LayerInfo name.
         * @member {string} name
         * @memberof stt.LayerInfo
         * @instance
         */
        LayerInfo.prototype.name = "";

        /**
         * LayerInfo description.
         * @member {string} description
         * @memberof stt.LayerInfo
         * @instance
         */
        LayerInfo.prototype.description = "";

        /**
         * LayerInfo properties.
         * @member {Array.<stt.IPropertyInfo>} properties
         * @memberof stt.LayerInfo
         * @instance
         */
        LayerInfo.prototype.properties = $util.emptyArray;

        /**
         * LayerInfo geometryTypes.
         * @member {Array.<string>} geometryTypes
         * @memberof stt.LayerInfo
         * @instance
         */
        LayerInfo.prototype.geometryTypes = $util.emptyArray;

        /**
         * Creates a new LayerInfo instance using the specified properties.
         * @function create
         * @memberof stt.LayerInfo
         * @static
         * @param {stt.ILayerInfo=} [properties] Properties to set
         * @returns {stt.LayerInfo} LayerInfo instance
         */
        LayerInfo.create = function create(properties) {
            return new LayerInfo(properties);
        };

        /**
         * Encodes the specified LayerInfo message. Does not implicitly {@link stt.LayerInfo.verify|verify} messages.
         * @function encode
         * @memberof stt.LayerInfo
         * @static
         * @param {stt.ILayerInfo} message LayerInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        LayerInfo.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.name != null && Object.hasOwnProperty.call(message, "name"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.name);
            if (message.description != null && Object.hasOwnProperty.call(message, "description"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.description);
            if (message.properties != null && message.properties.length)
                for (let i = 0; i < message.properties.length; ++i)
                    $root.stt.PropertyInfo.encode(message.properties[i], writer.uint32(/* id 3, wireType 2 =*/26).fork()).ldelim();
            if (message.geometryTypes != null && message.geometryTypes.length)
                for (let i = 0; i < message.geometryTypes.length; ++i)
                    writer.uint32(/* id 4, wireType 2 =*/34).string(message.geometryTypes[i]);
            return writer;
        };

        /**
         * Encodes the specified LayerInfo message, length delimited. Does not implicitly {@link stt.LayerInfo.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.LayerInfo
         * @static
         * @param {stt.ILayerInfo} message LayerInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        LayerInfo.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a LayerInfo message from the specified reader or buffer.
         * @function decode
         * @memberof stt.LayerInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.LayerInfo} LayerInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        LayerInfo.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.LayerInfo();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.name = reader.string();
                        break;
                    }
                case 2: {
                        message.description = reader.string();
                        break;
                    }
                case 3: {
                        if (!(message.properties && message.properties.length))
                            message.properties = [];
                        message.properties.push($root.stt.PropertyInfo.decode(reader, reader.uint32()));
                        break;
                    }
                case 4: {
                        if (!(message.geometryTypes && message.geometryTypes.length))
                            message.geometryTypes = [];
                        message.geometryTypes.push(reader.string());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a LayerInfo message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.LayerInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.LayerInfo} LayerInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        LayerInfo.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a LayerInfo message.
         * @function verify
         * @memberof stt.LayerInfo
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        LayerInfo.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.name != null && message.hasOwnProperty("name"))
                if (!$util.isString(message.name))
                    return "name: string expected";
            if (message.description != null && message.hasOwnProperty("description"))
                if (!$util.isString(message.description))
                    return "description: string expected";
            if (message.properties != null && message.hasOwnProperty("properties")) {
                if (!Array.isArray(message.properties))
                    return "properties: array expected";
                for (let i = 0; i < message.properties.length; ++i) {
                    let error = $root.stt.PropertyInfo.verify(message.properties[i]);
                    if (error)
                        return "properties." + error;
                }
            }
            if (message.geometryTypes != null && message.hasOwnProperty("geometryTypes")) {
                if (!Array.isArray(message.geometryTypes))
                    return "geometryTypes: array expected";
                for (let i = 0; i < message.geometryTypes.length; ++i)
                    if (!$util.isString(message.geometryTypes[i]))
                        return "geometryTypes: string[] expected";
            }
            return null;
        };

        /**
         * Creates a LayerInfo message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.LayerInfo
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.LayerInfo} LayerInfo
         */
        LayerInfo.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.LayerInfo)
                return object;
            let message = new $root.stt.LayerInfo();
            if (object.name != null)
                message.name = String(object.name);
            if (object.description != null)
                message.description = String(object.description);
            if (object.properties) {
                if (!Array.isArray(object.properties))
                    throw TypeError(".stt.LayerInfo.properties: array expected");
                message.properties = [];
                for (let i = 0; i < object.properties.length; ++i) {
                    if (typeof object.properties[i] !== "object")
                        throw TypeError(".stt.LayerInfo.properties: object expected");
                    message.properties[i] = $root.stt.PropertyInfo.fromObject(object.properties[i]);
                }
            }
            if (object.geometryTypes) {
                if (!Array.isArray(object.geometryTypes))
                    throw TypeError(".stt.LayerInfo.geometryTypes: array expected");
                message.geometryTypes = [];
                for (let i = 0; i < object.geometryTypes.length; ++i)
                    message.geometryTypes[i] = String(object.geometryTypes[i]);
            }
            return message;
        };

        /**
         * Creates a plain object from a LayerInfo message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.LayerInfo
         * @static
         * @param {stt.LayerInfo} message LayerInfo
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        LayerInfo.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults) {
                object.properties = [];
                object.geometryTypes = [];
            }
            if (options.defaults) {
                object.name = "";
                object.description = "";
            }
            if (message.name != null && message.hasOwnProperty("name"))
                object.name = message.name;
            if (message.description != null && message.hasOwnProperty("description"))
                object.description = message.description;
            if (message.properties && message.properties.length) {
                object.properties = [];
                for (let j = 0; j < message.properties.length; ++j)
                    object.properties[j] = $root.stt.PropertyInfo.toObject(message.properties[j], options);
            }
            if (message.geometryTypes && message.geometryTypes.length) {
                object.geometryTypes = [];
                for (let j = 0; j < message.geometryTypes.length; ++j)
                    object.geometryTypes[j] = message.geometryTypes[j];
            }
            return object;
        };

        /**
         * Converts this LayerInfo to JSON.
         * @function toJSON
         * @memberof stt.LayerInfo
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        LayerInfo.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for LayerInfo
         * @function getTypeUrl
         * @memberof stt.LayerInfo
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        LayerInfo.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.LayerInfo";
        };

        return LayerInfo;
    })();

    stt.PropertyInfo = (function() {

        /**
         * Properties of a PropertyInfo.
         * @memberof stt
         * @interface IPropertyInfo
         * @property {string|null} [name] PropertyInfo name
         * @property {string|null} [type] PropertyInfo type
         * @property {string|null} [description] PropertyInfo description
         * @property {number|null} [minValue] PropertyInfo minValue
         * @property {number|null} [maxValue] PropertyInfo maxValue
         */

        /**
         * Constructs a new PropertyInfo.
         * @memberof stt
         * @classdesc Represents a PropertyInfo.
         * @implements IPropertyInfo
         * @constructor
         * @param {stt.IPropertyInfo=} [properties] Properties to set
         */
        function PropertyInfo(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * PropertyInfo name.
         * @member {string} name
         * @memberof stt.PropertyInfo
         * @instance
         */
        PropertyInfo.prototype.name = "";

        /**
         * PropertyInfo type.
         * @member {string} type
         * @memberof stt.PropertyInfo
         * @instance
         */
        PropertyInfo.prototype.type = "";

        /**
         * PropertyInfo description.
         * @member {string} description
         * @memberof stt.PropertyInfo
         * @instance
         */
        PropertyInfo.prototype.description = "";

        /**
         * PropertyInfo minValue.
         * @member {number} minValue
         * @memberof stt.PropertyInfo
         * @instance
         */
        PropertyInfo.prototype.minValue = 0;

        /**
         * PropertyInfo maxValue.
         * @member {number} maxValue
         * @memberof stt.PropertyInfo
         * @instance
         */
        PropertyInfo.prototype.maxValue = 0;

        /**
         * Creates a new PropertyInfo instance using the specified properties.
         * @function create
         * @memberof stt.PropertyInfo
         * @static
         * @param {stt.IPropertyInfo=} [properties] Properties to set
         * @returns {stt.PropertyInfo} PropertyInfo instance
         */
        PropertyInfo.create = function create(properties) {
            return new PropertyInfo(properties);
        };

        /**
         * Encodes the specified PropertyInfo message. Does not implicitly {@link stt.PropertyInfo.verify|verify} messages.
         * @function encode
         * @memberof stt.PropertyInfo
         * @static
         * @param {stt.IPropertyInfo} message PropertyInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PropertyInfo.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.name != null && Object.hasOwnProperty.call(message, "name"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.name);
            if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.type);
            if (message.description != null && Object.hasOwnProperty.call(message, "description"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.description);
            if (message.minValue != null && Object.hasOwnProperty.call(message, "minValue"))
                writer.uint32(/* id 4, wireType 1 =*/33).double(message.minValue);
            if (message.maxValue != null && Object.hasOwnProperty.call(message, "maxValue"))
                writer.uint32(/* id 5, wireType 1 =*/41).double(message.maxValue);
            return writer;
        };

        /**
         * Encodes the specified PropertyInfo message, length delimited. Does not implicitly {@link stt.PropertyInfo.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.PropertyInfo
         * @static
         * @param {stt.IPropertyInfo} message PropertyInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PropertyInfo.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a PropertyInfo message from the specified reader or buffer.
         * @function decode
         * @memberof stt.PropertyInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.PropertyInfo} PropertyInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PropertyInfo.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.PropertyInfo();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.name = reader.string();
                        break;
                    }
                case 2: {
                        message.type = reader.string();
                        break;
                    }
                case 3: {
                        message.description = reader.string();
                        break;
                    }
                case 4: {
                        message.minValue = reader.double();
                        break;
                    }
                case 5: {
                        message.maxValue = reader.double();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a PropertyInfo message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.PropertyInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.PropertyInfo} PropertyInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PropertyInfo.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a PropertyInfo message.
         * @function verify
         * @memberof stt.PropertyInfo
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        PropertyInfo.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.name != null && message.hasOwnProperty("name"))
                if (!$util.isString(message.name))
                    return "name: string expected";
            if (message.type != null && message.hasOwnProperty("type"))
                if (!$util.isString(message.type))
                    return "type: string expected";
            if (message.description != null && message.hasOwnProperty("description"))
                if (!$util.isString(message.description))
                    return "description: string expected";
            if (message.minValue != null && message.hasOwnProperty("minValue"))
                if (typeof message.minValue !== "number")
                    return "minValue: number expected";
            if (message.maxValue != null && message.hasOwnProperty("maxValue"))
                if (typeof message.maxValue !== "number")
                    return "maxValue: number expected";
            return null;
        };

        /**
         * Creates a PropertyInfo message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.PropertyInfo
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.PropertyInfo} PropertyInfo
         */
        PropertyInfo.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.PropertyInfo)
                return object;
            let message = new $root.stt.PropertyInfo();
            if (object.name != null)
                message.name = String(object.name);
            if (object.type != null)
                message.type = String(object.type);
            if (object.description != null)
                message.description = String(object.description);
            if (object.minValue != null)
                message.minValue = Number(object.minValue);
            if (object.maxValue != null)
                message.maxValue = Number(object.maxValue);
            return message;
        };

        /**
         * Creates a plain object from a PropertyInfo message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.PropertyInfo
         * @static
         * @param {stt.PropertyInfo} message PropertyInfo
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        PropertyInfo.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.name = "";
                object.type = "";
                object.description = "";
                object.minValue = 0;
                object.maxValue = 0;
            }
            if (message.name != null && message.hasOwnProperty("name"))
                object.name = message.name;
            if (message.type != null && message.hasOwnProperty("type"))
                object.type = message.type;
            if (message.description != null && message.hasOwnProperty("description"))
                object.description = message.description;
            if (message.minValue != null && message.hasOwnProperty("minValue"))
                object.minValue = options.json && !isFinite(message.minValue) ? String(message.minValue) : message.minValue;
            if (message.maxValue != null && message.hasOwnProperty("maxValue"))
                object.maxValue = options.json && !isFinite(message.maxValue) ? String(message.maxValue) : message.maxValue;
            return object;
        };

        /**
         * Converts this PropertyInfo to JSON.
         * @function toJSON
         * @memberof stt.PropertyInfo
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        PropertyInfo.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for PropertyInfo
         * @function getTypeUrl
         * @memberof stt.PropertyInfo
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        PropertyInfo.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.PropertyInfo";
        };

        return PropertyInfo;
    })();

    stt.GenerationInfo = (function() {

        /**
         * Properties of a GenerationInfo.
         * @memberof stt
         * @interface IGenerationInfo
         * @property {string|null} [tool] GenerationInfo tool
         * @property {string|null} [version] GenerationInfo version
         * @property {number|Long|null} [timestamp] GenerationInfo timestamp
         * @property {string|null} [source] GenerationInfo source
         * @property {Array.<string>|null} [args] GenerationInfo args
         */

        /**
         * Constructs a new GenerationInfo.
         * @memberof stt
         * @classdesc Represents a GenerationInfo.
         * @implements IGenerationInfo
         * @constructor
         * @param {stt.IGenerationInfo=} [properties] Properties to set
         */
        function GenerationInfo(properties) {
            this.args = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * GenerationInfo tool.
         * @member {string} tool
         * @memberof stt.GenerationInfo
         * @instance
         */
        GenerationInfo.prototype.tool = "";

        /**
         * GenerationInfo version.
         * @member {string} version
         * @memberof stt.GenerationInfo
         * @instance
         */
        GenerationInfo.prototype.version = "";

        /**
         * GenerationInfo timestamp.
         * @member {number|Long} timestamp
         * @memberof stt.GenerationInfo
         * @instance
         */
        GenerationInfo.prototype.timestamp = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * GenerationInfo source.
         * @member {string} source
         * @memberof stt.GenerationInfo
         * @instance
         */
        GenerationInfo.prototype.source = "";

        /**
         * GenerationInfo args.
         * @member {Array.<string>} args
         * @memberof stt.GenerationInfo
         * @instance
         */
        GenerationInfo.prototype.args = $util.emptyArray;

        /**
         * Creates a new GenerationInfo instance using the specified properties.
         * @function create
         * @memberof stt.GenerationInfo
         * @static
         * @param {stt.IGenerationInfo=} [properties] Properties to set
         * @returns {stt.GenerationInfo} GenerationInfo instance
         */
        GenerationInfo.create = function create(properties) {
            return new GenerationInfo(properties);
        };

        /**
         * Encodes the specified GenerationInfo message. Does not implicitly {@link stt.GenerationInfo.verify|verify} messages.
         * @function encode
         * @memberof stt.GenerationInfo
         * @static
         * @param {stt.IGenerationInfo} message GenerationInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        GenerationInfo.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.tool != null && Object.hasOwnProperty.call(message, "tool"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.tool);
            if (message.version != null && Object.hasOwnProperty.call(message, "version"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.version);
            if (message.timestamp != null && Object.hasOwnProperty.call(message, "timestamp"))
                writer.uint32(/* id 3, wireType 0 =*/24).uint64(message.timestamp);
            if (message.source != null && Object.hasOwnProperty.call(message, "source"))
                writer.uint32(/* id 4, wireType 2 =*/34).string(message.source);
            if (message.args != null && message.args.length)
                for (let i = 0; i < message.args.length; ++i)
                    writer.uint32(/* id 5, wireType 2 =*/42).string(message.args[i]);
            return writer;
        };

        /**
         * Encodes the specified GenerationInfo message, length delimited. Does not implicitly {@link stt.GenerationInfo.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.GenerationInfo
         * @static
         * @param {stt.IGenerationInfo} message GenerationInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        GenerationInfo.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a GenerationInfo message from the specified reader or buffer.
         * @function decode
         * @memberof stt.GenerationInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.GenerationInfo} GenerationInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        GenerationInfo.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.GenerationInfo();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.tool = reader.string();
                        break;
                    }
                case 2: {
                        message.version = reader.string();
                        break;
                    }
                case 3: {
                        message.timestamp = reader.uint64();
                        break;
                    }
                case 4: {
                        message.source = reader.string();
                        break;
                    }
                case 5: {
                        if (!(message.args && message.args.length))
                            message.args = [];
                        message.args.push(reader.string());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a GenerationInfo message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.GenerationInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.GenerationInfo} GenerationInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        GenerationInfo.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a GenerationInfo message.
         * @function verify
         * @memberof stt.GenerationInfo
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        GenerationInfo.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.tool != null && message.hasOwnProperty("tool"))
                if (!$util.isString(message.tool))
                    return "tool: string expected";
            if (message.version != null && message.hasOwnProperty("version"))
                if (!$util.isString(message.version))
                    return "version: string expected";
            if (message.timestamp != null && message.hasOwnProperty("timestamp"))
                if (!$util.isInteger(message.timestamp) && !(message.timestamp && $util.isInteger(message.timestamp.low) && $util.isInteger(message.timestamp.high)))
                    return "timestamp: integer|Long expected";
            if (message.source != null && message.hasOwnProperty("source"))
                if (!$util.isString(message.source))
                    return "source: string expected";
            if (message.args != null && message.hasOwnProperty("args")) {
                if (!Array.isArray(message.args))
                    return "args: array expected";
                for (let i = 0; i < message.args.length; ++i)
                    if (!$util.isString(message.args[i]))
                        return "args: string[] expected";
            }
            return null;
        };

        /**
         * Creates a GenerationInfo message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.GenerationInfo
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.GenerationInfo} GenerationInfo
         */
        GenerationInfo.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.GenerationInfo)
                return object;
            let message = new $root.stt.GenerationInfo();
            if (object.tool != null)
                message.tool = String(object.tool);
            if (object.version != null)
                message.version = String(object.version);
            if (object.timestamp != null)
                if ($util.Long)
                    (message.timestamp = $util.Long.fromValue(object.timestamp)).unsigned = true;
                else if (typeof object.timestamp === "string")
                    message.timestamp = parseInt(object.timestamp, 10);
                else if (typeof object.timestamp === "number")
                    message.timestamp = object.timestamp;
                else if (typeof object.timestamp === "object")
                    message.timestamp = new $util.LongBits(object.timestamp.low >>> 0, object.timestamp.high >>> 0).toNumber(true);
            if (object.source != null)
                message.source = String(object.source);
            if (object.args) {
                if (!Array.isArray(object.args))
                    throw TypeError(".stt.GenerationInfo.args: array expected");
                message.args = [];
                for (let i = 0; i < object.args.length; ++i)
                    message.args[i] = String(object.args[i]);
            }
            return message;
        };

        /**
         * Creates a plain object from a GenerationInfo message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.GenerationInfo
         * @static
         * @param {stt.GenerationInfo} message GenerationInfo
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        GenerationInfo.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.args = [];
            if (options.defaults) {
                object.tool = "";
                object.version = "";
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.timestamp = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.timestamp = options.longs === String ? "0" : 0;
                object.source = "";
            }
            if (message.tool != null && message.hasOwnProperty("tool"))
                object.tool = message.tool;
            if (message.version != null && message.hasOwnProperty("version"))
                object.version = message.version;
            if (message.timestamp != null && message.hasOwnProperty("timestamp"))
                if (typeof message.timestamp === "number")
                    object.timestamp = options.longs === String ? String(message.timestamp) : message.timestamp;
                else
                    object.timestamp = options.longs === String ? $util.Long.prototype.toString.call(message.timestamp) : options.longs === Number ? new $util.LongBits(message.timestamp.low >>> 0, message.timestamp.high >>> 0).toNumber(true) : message.timestamp;
            if (message.source != null && message.hasOwnProperty("source"))
                object.source = message.source;
            if (message.args && message.args.length) {
                object.args = [];
                for (let j = 0; j < message.args.length; ++j)
                    object.args[j] = message.args[j];
            }
            return object;
        };

        /**
         * Converts this GenerationInfo to JSON.
         * @function toJSON
         * @memberof stt.GenerationInfo
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        GenerationInfo.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for GenerationInfo
         * @function getTypeUrl
         * @memberof stt.GenerationInfo
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        GenerationInfo.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.GenerationInfo";
        };

        return GenerationInfo;
    })();

    stt.Statistics = (function() {

        /**
         * Properties of a Statistics.
         * @memberof stt
         * @interface IStatistics
         * @property {number|Long|null} [totalTiles] Statistics totalTiles
         * @property {number|Long|null} [totalFeatures] Statistics totalFeatures
         * @property {number|Long|null} [totalSize] Statistics totalSize
         * @property {number|Long|null} [uncompressedSize] Statistics uncompressedSize
         * @property {number|null} [compressionRatio] Statistics compressionRatio
         * @property {Array.<stt.IZoomStats>|null} [zoomStats] Statistics zoomStats
         */

        /**
         * Constructs a new Statistics.
         * @memberof stt
         * @classdesc Represents a Statistics.
         * @implements IStatistics
         * @constructor
         * @param {stt.IStatistics=} [properties] Properties to set
         */
        function Statistics(properties) {
            this.zoomStats = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Statistics totalTiles.
         * @member {number|Long} totalTiles
         * @memberof stt.Statistics
         * @instance
         */
        Statistics.prototype.totalTiles = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * Statistics totalFeatures.
         * @member {number|Long} totalFeatures
         * @memberof stt.Statistics
         * @instance
         */
        Statistics.prototype.totalFeatures = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * Statistics totalSize.
         * @member {number|Long} totalSize
         * @memberof stt.Statistics
         * @instance
         */
        Statistics.prototype.totalSize = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * Statistics uncompressedSize.
         * @member {number|Long} uncompressedSize
         * @memberof stt.Statistics
         * @instance
         */
        Statistics.prototype.uncompressedSize = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * Statistics compressionRatio.
         * @member {number} compressionRatio
         * @memberof stt.Statistics
         * @instance
         */
        Statistics.prototype.compressionRatio = 0;

        /**
         * Statistics zoomStats.
         * @member {Array.<stt.IZoomStats>} zoomStats
         * @memberof stt.Statistics
         * @instance
         */
        Statistics.prototype.zoomStats = $util.emptyArray;

        /**
         * Creates a new Statistics instance using the specified properties.
         * @function create
         * @memberof stt.Statistics
         * @static
         * @param {stt.IStatistics=} [properties] Properties to set
         * @returns {stt.Statistics} Statistics instance
         */
        Statistics.create = function create(properties) {
            return new Statistics(properties);
        };

        /**
         * Encodes the specified Statistics message. Does not implicitly {@link stt.Statistics.verify|verify} messages.
         * @function encode
         * @memberof stt.Statistics
         * @static
         * @param {stt.IStatistics} message Statistics message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Statistics.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.totalTiles != null && Object.hasOwnProperty.call(message, "totalTiles"))
                writer.uint32(/* id 1, wireType 0 =*/8).uint64(message.totalTiles);
            if (message.totalFeatures != null && Object.hasOwnProperty.call(message, "totalFeatures"))
                writer.uint32(/* id 2, wireType 0 =*/16).uint64(message.totalFeatures);
            if (message.totalSize != null && Object.hasOwnProperty.call(message, "totalSize"))
                writer.uint32(/* id 3, wireType 0 =*/24).uint64(message.totalSize);
            if (message.uncompressedSize != null && Object.hasOwnProperty.call(message, "uncompressedSize"))
                writer.uint32(/* id 4, wireType 0 =*/32).uint64(message.uncompressedSize);
            if (message.compressionRatio != null && Object.hasOwnProperty.call(message, "compressionRatio"))
                writer.uint32(/* id 5, wireType 1 =*/41).double(message.compressionRatio);
            if (message.zoomStats != null && message.zoomStats.length)
                for (let i = 0; i < message.zoomStats.length; ++i)
                    $root.stt.ZoomStats.encode(message.zoomStats[i], writer.uint32(/* id 6, wireType 2 =*/50).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified Statistics message, length delimited. Does not implicitly {@link stt.Statistics.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.Statistics
         * @static
         * @param {stt.IStatistics} message Statistics message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Statistics.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a Statistics message from the specified reader or buffer.
         * @function decode
         * @memberof stt.Statistics
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.Statistics} Statistics
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Statistics.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.Statistics();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.totalTiles = reader.uint64();
                        break;
                    }
                case 2: {
                        message.totalFeatures = reader.uint64();
                        break;
                    }
                case 3: {
                        message.totalSize = reader.uint64();
                        break;
                    }
                case 4: {
                        message.uncompressedSize = reader.uint64();
                        break;
                    }
                case 5: {
                        message.compressionRatio = reader.double();
                        break;
                    }
                case 6: {
                        if (!(message.zoomStats && message.zoomStats.length))
                            message.zoomStats = [];
                        message.zoomStats.push($root.stt.ZoomStats.decode(reader, reader.uint32()));
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a Statistics message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.Statistics
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.Statistics} Statistics
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Statistics.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Statistics message.
         * @function verify
         * @memberof stt.Statistics
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Statistics.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.totalTiles != null && message.hasOwnProperty("totalTiles"))
                if (!$util.isInteger(message.totalTiles) && !(message.totalTiles && $util.isInteger(message.totalTiles.low) && $util.isInteger(message.totalTiles.high)))
                    return "totalTiles: integer|Long expected";
            if (message.totalFeatures != null && message.hasOwnProperty("totalFeatures"))
                if (!$util.isInteger(message.totalFeatures) && !(message.totalFeatures && $util.isInteger(message.totalFeatures.low) && $util.isInteger(message.totalFeatures.high)))
                    return "totalFeatures: integer|Long expected";
            if (message.totalSize != null && message.hasOwnProperty("totalSize"))
                if (!$util.isInteger(message.totalSize) && !(message.totalSize && $util.isInteger(message.totalSize.low) && $util.isInteger(message.totalSize.high)))
                    return "totalSize: integer|Long expected";
            if (message.uncompressedSize != null && message.hasOwnProperty("uncompressedSize"))
                if (!$util.isInteger(message.uncompressedSize) && !(message.uncompressedSize && $util.isInteger(message.uncompressedSize.low) && $util.isInteger(message.uncompressedSize.high)))
                    return "uncompressedSize: integer|Long expected";
            if (message.compressionRatio != null && message.hasOwnProperty("compressionRatio"))
                if (typeof message.compressionRatio !== "number")
                    return "compressionRatio: number expected";
            if (message.zoomStats != null && message.hasOwnProperty("zoomStats")) {
                if (!Array.isArray(message.zoomStats))
                    return "zoomStats: array expected";
                for (let i = 0; i < message.zoomStats.length; ++i) {
                    let error = $root.stt.ZoomStats.verify(message.zoomStats[i]);
                    if (error)
                        return "zoomStats." + error;
                }
            }
            return null;
        };

        /**
         * Creates a Statistics message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.Statistics
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.Statistics} Statistics
         */
        Statistics.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.Statistics)
                return object;
            let message = new $root.stt.Statistics();
            if (object.totalTiles != null)
                if ($util.Long)
                    (message.totalTiles = $util.Long.fromValue(object.totalTiles)).unsigned = true;
                else if (typeof object.totalTiles === "string")
                    message.totalTiles = parseInt(object.totalTiles, 10);
                else if (typeof object.totalTiles === "number")
                    message.totalTiles = object.totalTiles;
                else if (typeof object.totalTiles === "object")
                    message.totalTiles = new $util.LongBits(object.totalTiles.low >>> 0, object.totalTiles.high >>> 0).toNumber(true);
            if (object.totalFeatures != null)
                if ($util.Long)
                    (message.totalFeatures = $util.Long.fromValue(object.totalFeatures)).unsigned = true;
                else if (typeof object.totalFeatures === "string")
                    message.totalFeatures = parseInt(object.totalFeatures, 10);
                else if (typeof object.totalFeatures === "number")
                    message.totalFeatures = object.totalFeatures;
                else if (typeof object.totalFeatures === "object")
                    message.totalFeatures = new $util.LongBits(object.totalFeatures.low >>> 0, object.totalFeatures.high >>> 0).toNumber(true);
            if (object.totalSize != null)
                if ($util.Long)
                    (message.totalSize = $util.Long.fromValue(object.totalSize)).unsigned = true;
                else if (typeof object.totalSize === "string")
                    message.totalSize = parseInt(object.totalSize, 10);
                else if (typeof object.totalSize === "number")
                    message.totalSize = object.totalSize;
                else if (typeof object.totalSize === "object")
                    message.totalSize = new $util.LongBits(object.totalSize.low >>> 0, object.totalSize.high >>> 0).toNumber(true);
            if (object.uncompressedSize != null)
                if ($util.Long)
                    (message.uncompressedSize = $util.Long.fromValue(object.uncompressedSize)).unsigned = true;
                else if (typeof object.uncompressedSize === "string")
                    message.uncompressedSize = parseInt(object.uncompressedSize, 10);
                else if (typeof object.uncompressedSize === "number")
                    message.uncompressedSize = object.uncompressedSize;
                else if (typeof object.uncompressedSize === "object")
                    message.uncompressedSize = new $util.LongBits(object.uncompressedSize.low >>> 0, object.uncompressedSize.high >>> 0).toNumber(true);
            if (object.compressionRatio != null)
                message.compressionRatio = Number(object.compressionRatio);
            if (object.zoomStats) {
                if (!Array.isArray(object.zoomStats))
                    throw TypeError(".stt.Statistics.zoomStats: array expected");
                message.zoomStats = [];
                for (let i = 0; i < object.zoomStats.length; ++i) {
                    if (typeof object.zoomStats[i] !== "object")
                        throw TypeError(".stt.Statistics.zoomStats: object expected");
                    message.zoomStats[i] = $root.stt.ZoomStats.fromObject(object.zoomStats[i]);
                }
            }
            return message;
        };

        /**
         * Creates a plain object from a Statistics message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.Statistics
         * @static
         * @param {stt.Statistics} message Statistics
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Statistics.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.zoomStats = [];
            if (options.defaults) {
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.totalTiles = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.totalTiles = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.totalFeatures = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.totalFeatures = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.totalSize = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.totalSize = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.uncompressedSize = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.uncompressedSize = options.longs === String ? "0" : 0;
                object.compressionRatio = 0;
            }
            if (message.totalTiles != null && message.hasOwnProperty("totalTiles"))
                if (typeof message.totalTiles === "number")
                    object.totalTiles = options.longs === String ? String(message.totalTiles) : message.totalTiles;
                else
                    object.totalTiles = options.longs === String ? $util.Long.prototype.toString.call(message.totalTiles) : options.longs === Number ? new $util.LongBits(message.totalTiles.low >>> 0, message.totalTiles.high >>> 0).toNumber(true) : message.totalTiles;
            if (message.totalFeatures != null && message.hasOwnProperty("totalFeatures"))
                if (typeof message.totalFeatures === "number")
                    object.totalFeatures = options.longs === String ? String(message.totalFeatures) : message.totalFeatures;
                else
                    object.totalFeatures = options.longs === String ? $util.Long.prototype.toString.call(message.totalFeatures) : options.longs === Number ? new $util.LongBits(message.totalFeatures.low >>> 0, message.totalFeatures.high >>> 0).toNumber(true) : message.totalFeatures;
            if (message.totalSize != null && message.hasOwnProperty("totalSize"))
                if (typeof message.totalSize === "number")
                    object.totalSize = options.longs === String ? String(message.totalSize) : message.totalSize;
                else
                    object.totalSize = options.longs === String ? $util.Long.prototype.toString.call(message.totalSize) : options.longs === Number ? new $util.LongBits(message.totalSize.low >>> 0, message.totalSize.high >>> 0).toNumber(true) : message.totalSize;
            if (message.uncompressedSize != null && message.hasOwnProperty("uncompressedSize"))
                if (typeof message.uncompressedSize === "number")
                    object.uncompressedSize = options.longs === String ? String(message.uncompressedSize) : message.uncompressedSize;
                else
                    object.uncompressedSize = options.longs === String ? $util.Long.prototype.toString.call(message.uncompressedSize) : options.longs === Number ? new $util.LongBits(message.uncompressedSize.low >>> 0, message.uncompressedSize.high >>> 0).toNumber(true) : message.uncompressedSize;
            if (message.compressionRatio != null && message.hasOwnProperty("compressionRatio"))
                object.compressionRatio = options.json && !isFinite(message.compressionRatio) ? String(message.compressionRatio) : message.compressionRatio;
            if (message.zoomStats && message.zoomStats.length) {
                object.zoomStats = [];
                for (let j = 0; j < message.zoomStats.length; ++j)
                    object.zoomStats[j] = $root.stt.ZoomStats.toObject(message.zoomStats[j], options);
            }
            return object;
        };

        /**
         * Converts this Statistics to JSON.
         * @function toJSON
         * @memberof stt.Statistics
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Statistics.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for Statistics
         * @function getTypeUrl
         * @memberof stt.Statistics
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        Statistics.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.Statistics";
        };

        return Statistics;
    })();

    stt.ZoomStats = (function() {

        /**
         * Properties of a ZoomStats.
         * @memberof stt
         * @interface IZoomStats
         * @property {number|null} [zoom] ZoomStats zoom
         * @property {number|Long|null} [tileCount] ZoomStats tileCount
         * @property {number|Long|null} [featureCount] ZoomStats featureCount
         * @property {number|Long|null} [totalSize] ZoomStats totalSize
         * @property {number|null} [avgTileSize] ZoomStats avgTileSize
         * @property {number|null} [avgFeaturesPerTile] ZoomStats avgFeaturesPerTile
         */

        /**
         * Constructs a new ZoomStats.
         * @memberof stt
         * @classdesc Represents a ZoomStats.
         * @implements IZoomStats
         * @constructor
         * @param {stt.IZoomStats=} [properties] Properties to set
         */
        function ZoomStats(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * ZoomStats zoom.
         * @member {number} zoom
         * @memberof stt.ZoomStats
         * @instance
         */
        ZoomStats.prototype.zoom = 0;

        /**
         * ZoomStats tileCount.
         * @member {number|Long} tileCount
         * @memberof stt.ZoomStats
         * @instance
         */
        ZoomStats.prototype.tileCount = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * ZoomStats featureCount.
         * @member {number|Long} featureCount
         * @memberof stt.ZoomStats
         * @instance
         */
        ZoomStats.prototype.featureCount = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * ZoomStats totalSize.
         * @member {number|Long} totalSize
         * @memberof stt.ZoomStats
         * @instance
         */
        ZoomStats.prototype.totalSize = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * ZoomStats avgTileSize.
         * @member {number} avgTileSize
         * @memberof stt.ZoomStats
         * @instance
         */
        ZoomStats.prototype.avgTileSize = 0;

        /**
         * ZoomStats avgFeaturesPerTile.
         * @member {number} avgFeaturesPerTile
         * @memberof stt.ZoomStats
         * @instance
         */
        ZoomStats.prototype.avgFeaturesPerTile = 0;

        /**
         * Creates a new ZoomStats instance using the specified properties.
         * @function create
         * @memberof stt.ZoomStats
         * @static
         * @param {stt.IZoomStats=} [properties] Properties to set
         * @returns {stt.ZoomStats} ZoomStats instance
         */
        ZoomStats.create = function create(properties) {
            return new ZoomStats(properties);
        };

        /**
         * Encodes the specified ZoomStats message. Does not implicitly {@link stt.ZoomStats.verify|verify} messages.
         * @function encode
         * @memberof stt.ZoomStats
         * @static
         * @param {stt.IZoomStats} message ZoomStats message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ZoomStats.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.zoom != null && Object.hasOwnProperty.call(message, "zoom"))
                writer.uint32(/* id 1, wireType 0 =*/8).uint32(message.zoom);
            if (message.tileCount != null && Object.hasOwnProperty.call(message, "tileCount"))
                writer.uint32(/* id 2, wireType 0 =*/16).uint64(message.tileCount);
            if (message.featureCount != null && Object.hasOwnProperty.call(message, "featureCount"))
                writer.uint32(/* id 3, wireType 0 =*/24).uint64(message.featureCount);
            if (message.totalSize != null && Object.hasOwnProperty.call(message, "totalSize"))
                writer.uint32(/* id 4, wireType 0 =*/32).uint64(message.totalSize);
            if (message.avgTileSize != null && Object.hasOwnProperty.call(message, "avgTileSize"))
                writer.uint32(/* id 5, wireType 1 =*/41).double(message.avgTileSize);
            if (message.avgFeaturesPerTile != null && Object.hasOwnProperty.call(message, "avgFeaturesPerTile"))
                writer.uint32(/* id 6, wireType 1 =*/49).double(message.avgFeaturesPerTile);
            return writer;
        };

        /**
         * Encodes the specified ZoomStats message, length delimited. Does not implicitly {@link stt.ZoomStats.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.ZoomStats
         * @static
         * @param {stt.IZoomStats} message ZoomStats message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ZoomStats.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a ZoomStats message from the specified reader or buffer.
         * @function decode
         * @memberof stt.ZoomStats
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.ZoomStats} ZoomStats
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ZoomStats.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.ZoomStats();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.zoom = reader.uint32();
                        break;
                    }
                case 2: {
                        message.tileCount = reader.uint64();
                        break;
                    }
                case 3: {
                        message.featureCount = reader.uint64();
                        break;
                    }
                case 4: {
                        message.totalSize = reader.uint64();
                        break;
                    }
                case 5: {
                        message.avgTileSize = reader.double();
                        break;
                    }
                case 6: {
                        message.avgFeaturesPerTile = reader.double();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a ZoomStats message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.ZoomStats
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.ZoomStats} ZoomStats
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ZoomStats.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a ZoomStats message.
         * @function verify
         * @memberof stt.ZoomStats
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        ZoomStats.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.zoom != null && message.hasOwnProperty("zoom"))
                if (!$util.isInteger(message.zoom))
                    return "zoom: integer expected";
            if (message.tileCount != null && message.hasOwnProperty("tileCount"))
                if (!$util.isInteger(message.tileCount) && !(message.tileCount && $util.isInteger(message.tileCount.low) && $util.isInteger(message.tileCount.high)))
                    return "tileCount: integer|Long expected";
            if (message.featureCount != null && message.hasOwnProperty("featureCount"))
                if (!$util.isInteger(message.featureCount) && !(message.featureCount && $util.isInteger(message.featureCount.low) && $util.isInteger(message.featureCount.high)))
                    return "featureCount: integer|Long expected";
            if (message.totalSize != null && message.hasOwnProperty("totalSize"))
                if (!$util.isInteger(message.totalSize) && !(message.totalSize && $util.isInteger(message.totalSize.low) && $util.isInteger(message.totalSize.high)))
                    return "totalSize: integer|Long expected";
            if (message.avgTileSize != null && message.hasOwnProperty("avgTileSize"))
                if (typeof message.avgTileSize !== "number")
                    return "avgTileSize: number expected";
            if (message.avgFeaturesPerTile != null && message.hasOwnProperty("avgFeaturesPerTile"))
                if (typeof message.avgFeaturesPerTile !== "number")
                    return "avgFeaturesPerTile: number expected";
            return null;
        };

        /**
         * Creates a ZoomStats message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.ZoomStats
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.ZoomStats} ZoomStats
         */
        ZoomStats.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.ZoomStats)
                return object;
            let message = new $root.stt.ZoomStats();
            if (object.zoom != null)
                message.zoom = object.zoom >>> 0;
            if (object.tileCount != null)
                if ($util.Long)
                    (message.tileCount = $util.Long.fromValue(object.tileCount)).unsigned = true;
                else if (typeof object.tileCount === "string")
                    message.tileCount = parseInt(object.tileCount, 10);
                else if (typeof object.tileCount === "number")
                    message.tileCount = object.tileCount;
                else if (typeof object.tileCount === "object")
                    message.tileCount = new $util.LongBits(object.tileCount.low >>> 0, object.tileCount.high >>> 0).toNumber(true);
            if (object.featureCount != null)
                if ($util.Long)
                    (message.featureCount = $util.Long.fromValue(object.featureCount)).unsigned = true;
                else if (typeof object.featureCount === "string")
                    message.featureCount = parseInt(object.featureCount, 10);
                else if (typeof object.featureCount === "number")
                    message.featureCount = object.featureCount;
                else if (typeof object.featureCount === "object")
                    message.featureCount = new $util.LongBits(object.featureCount.low >>> 0, object.featureCount.high >>> 0).toNumber(true);
            if (object.totalSize != null)
                if ($util.Long)
                    (message.totalSize = $util.Long.fromValue(object.totalSize)).unsigned = true;
                else if (typeof object.totalSize === "string")
                    message.totalSize = parseInt(object.totalSize, 10);
                else if (typeof object.totalSize === "number")
                    message.totalSize = object.totalSize;
                else if (typeof object.totalSize === "object")
                    message.totalSize = new $util.LongBits(object.totalSize.low >>> 0, object.totalSize.high >>> 0).toNumber(true);
            if (object.avgTileSize != null)
                message.avgTileSize = Number(object.avgTileSize);
            if (object.avgFeaturesPerTile != null)
                message.avgFeaturesPerTile = Number(object.avgFeaturesPerTile);
            return message;
        };

        /**
         * Creates a plain object from a ZoomStats message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.ZoomStats
         * @static
         * @param {stt.ZoomStats} message ZoomStats
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        ZoomStats.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.zoom = 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.tileCount = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.tileCount = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.featureCount = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.featureCount = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.totalSize = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.totalSize = options.longs === String ? "0" : 0;
                object.avgTileSize = 0;
                object.avgFeaturesPerTile = 0;
            }
            if (message.zoom != null && message.hasOwnProperty("zoom"))
                object.zoom = message.zoom;
            if (message.tileCount != null && message.hasOwnProperty("tileCount"))
                if (typeof message.tileCount === "number")
                    object.tileCount = options.longs === String ? String(message.tileCount) : message.tileCount;
                else
                    object.tileCount = options.longs === String ? $util.Long.prototype.toString.call(message.tileCount) : options.longs === Number ? new $util.LongBits(message.tileCount.low >>> 0, message.tileCount.high >>> 0).toNumber(true) : message.tileCount;
            if (message.featureCount != null && message.hasOwnProperty("featureCount"))
                if (typeof message.featureCount === "number")
                    object.featureCount = options.longs === String ? String(message.featureCount) : message.featureCount;
                else
                    object.featureCount = options.longs === String ? $util.Long.prototype.toString.call(message.featureCount) : options.longs === Number ? new $util.LongBits(message.featureCount.low >>> 0, message.featureCount.high >>> 0).toNumber(true) : message.featureCount;
            if (message.totalSize != null && message.hasOwnProperty("totalSize"))
                if (typeof message.totalSize === "number")
                    object.totalSize = options.longs === String ? String(message.totalSize) : message.totalSize;
                else
                    object.totalSize = options.longs === String ? $util.Long.prototype.toString.call(message.totalSize) : options.longs === Number ? new $util.LongBits(message.totalSize.low >>> 0, message.totalSize.high >>> 0).toNumber(true) : message.totalSize;
            if (message.avgTileSize != null && message.hasOwnProperty("avgTileSize"))
                object.avgTileSize = options.json && !isFinite(message.avgTileSize) ? String(message.avgTileSize) : message.avgTileSize;
            if (message.avgFeaturesPerTile != null && message.hasOwnProperty("avgFeaturesPerTile"))
                object.avgFeaturesPerTile = options.json && !isFinite(message.avgFeaturesPerTile) ? String(message.avgFeaturesPerTile) : message.avgFeaturesPerTile;
            return object;
        };

        /**
         * Converts this ZoomStats to JSON.
         * @function toJSON
         * @memberof stt.ZoomStats
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ZoomStats.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for ZoomStats
         * @function getTypeUrl
         * @memberof stt.ZoomStats
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        ZoomStats.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.ZoomStats";
        };

        return ZoomStats;
    })();

    stt.Tile = (function() {

        /**
         * Properties of a Tile.
         * @memberof stt
         * @interface ITile
         * @property {number|null} [version] Tile version
         * @property {number|Long|null} [timeStart] Tile timeStart
         * @property {number|Long|null} [timeEnd] Tile timeEnd
         * @property {Array.<stt.ILayer>|null} [layers] Tile layers
         */

        /**
         * Constructs a new Tile.
         * @memberof stt
         * @classdesc Represents a Tile.
         * @implements ITile
         * @constructor
         * @param {stt.ITile=} [properties] Properties to set
         */
        function Tile(properties) {
            this.layers = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Tile version.
         * @member {number} version
         * @memberof stt.Tile
         * @instance
         */
        Tile.prototype.version = 0;

        /**
         * Tile timeStart.
         * @member {number|Long} timeStart
         * @memberof stt.Tile
         * @instance
         */
        Tile.prototype.timeStart = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * Tile timeEnd.
         * @member {number|Long} timeEnd
         * @memberof stt.Tile
         * @instance
         */
        Tile.prototype.timeEnd = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        /**
         * Tile layers.
         * @member {Array.<stt.ILayer>} layers
         * @memberof stt.Tile
         * @instance
         */
        Tile.prototype.layers = $util.emptyArray;

        /**
         * Creates a new Tile instance using the specified properties.
         * @function create
         * @memberof stt.Tile
         * @static
         * @param {stt.ITile=} [properties] Properties to set
         * @returns {stt.Tile} Tile instance
         */
        Tile.create = function create(properties) {
            return new Tile(properties);
        };

        /**
         * Encodes the specified Tile message. Does not implicitly {@link stt.Tile.verify|verify} messages.
         * @function encode
         * @memberof stt.Tile
         * @static
         * @param {stt.ITile} message Tile message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Tile.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.version != null && Object.hasOwnProperty.call(message, "version"))
                writer.uint32(/* id 1, wireType 0 =*/8).uint32(message.version);
            if (message.timeStart != null && Object.hasOwnProperty.call(message, "timeStart"))
                writer.uint32(/* id 2, wireType 0 =*/16).uint64(message.timeStart);
            if (message.timeEnd != null && Object.hasOwnProperty.call(message, "timeEnd"))
                writer.uint32(/* id 3, wireType 0 =*/24).uint64(message.timeEnd);
            if (message.layers != null && message.layers.length)
                for (let i = 0; i < message.layers.length; ++i)
                    $root.stt.Layer.encode(message.layers[i], writer.uint32(/* id 4, wireType 2 =*/34).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified Tile message, length delimited. Does not implicitly {@link stt.Tile.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.Tile
         * @static
         * @param {stt.ITile} message Tile message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Tile.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a Tile message from the specified reader or buffer.
         * @function decode
         * @memberof stt.Tile
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.Tile} Tile
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Tile.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.Tile();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.version = reader.uint32();
                        break;
                    }
                case 2: {
                        message.timeStart = reader.uint64();
                        break;
                    }
                case 3: {
                        message.timeEnd = reader.uint64();
                        break;
                    }
                case 4: {
                        if (!(message.layers && message.layers.length))
                            message.layers = [];
                        message.layers.push($root.stt.Layer.decode(reader, reader.uint32()));
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a Tile message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.Tile
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.Tile} Tile
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Tile.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Tile message.
         * @function verify
         * @memberof stt.Tile
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Tile.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.version != null && message.hasOwnProperty("version"))
                if (!$util.isInteger(message.version))
                    return "version: integer expected";
            if (message.timeStart != null && message.hasOwnProperty("timeStart"))
                if (!$util.isInteger(message.timeStart) && !(message.timeStart && $util.isInteger(message.timeStart.low) && $util.isInteger(message.timeStart.high)))
                    return "timeStart: integer|Long expected";
            if (message.timeEnd != null && message.hasOwnProperty("timeEnd"))
                if (!$util.isInteger(message.timeEnd) && !(message.timeEnd && $util.isInteger(message.timeEnd.low) && $util.isInteger(message.timeEnd.high)))
                    return "timeEnd: integer|Long expected";
            if (message.layers != null && message.hasOwnProperty("layers")) {
                if (!Array.isArray(message.layers))
                    return "layers: array expected";
                for (let i = 0; i < message.layers.length; ++i) {
                    let error = $root.stt.Layer.verify(message.layers[i]);
                    if (error)
                        return "layers." + error;
                }
            }
            return null;
        };

        /**
         * Creates a Tile message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.Tile
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.Tile} Tile
         */
        Tile.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.Tile)
                return object;
            let message = new $root.stt.Tile();
            if (object.version != null)
                message.version = object.version >>> 0;
            if (object.timeStart != null)
                if ($util.Long)
                    (message.timeStart = $util.Long.fromValue(object.timeStart)).unsigned = true;
                else if (typeof object.timeStart === "string")
                    message.timeStart = parseInt(object.timeStart, 10);
                else if (typeof object.timeStart === "number")
                    message.timeStart = object.timeStart;
                else if (typeof object.timeStart === "object")
                    message.timeStart = new $util.LongBits(object.timeStart.low >>> 0, object.timeStart.high >>> 0).toNumber(true);
            if (object.timeEnd != null)
                if ($util.Long)
                    (message.timeEnd = $util.Long.fromValue(object.timeEnd)).unsigned = true;
                else if (typeof object.timeEnd === "string")
                    message.timeEnd = parseInt(object.timeEnd, 10);
                else if (typeof object.timeEnd === "number")
                    message.timeEnd = object.timeEnd;
                else if (typeof object.timeEnd === "object")
                    message.timeEnd = new $util.LongBits(object.timeEnd.low >>> 0, object.timeEnd.high >>> 0).toNumber(true);
            if (object.layers) {
                if (!Array.isArray(object.layers))
                    throw TypeError(".stt.Tile.layers: array expected");
                message.layers = [];
                for (let i = 0; i < object.layers.length; ++i) {
                    if (typeof object.layers[i] !== "object")
                        throw TypeError(".stt.Tile.layers: object expected");
                    message.layers[i] = $root.stt.Layer.fromObject(object.layers[i]);
                }
            }
            return message;
        };

        /**
         * Creates a plain object from a Tile message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.Tile
         * @static
         * @param {stt.Tile} message Tile
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Tile.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.layers = [];
            if (options.defaults) {
                object.version = 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.timeStart = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.timeStart = options.longs === String ? "0" : 0;
                if ($util.Long) {
                    let long = new $util.Long(0, 0, true);
                    object.timeEnd = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                } else
                    object.timeEnd = options.longs === String ? "0" : 0;
            }
            if (message.version != null && message.hasOwnProperty("version"))
                object.version = message.version;
            if (message.timeStart != null && message.hasOwnProperty("timeStart"))
                if (typeof message.timeStart === "number")
                    object.timeStart = options.longs === String ? String(message.timeStart) : message.timeStart;
                else
                    object.timeStart = options.longs === String ? $util.Long.prototype.toString.call(message.timeStart) : options.longs === Number ? new $util.LongBits(message.timeStart.low >>> 0, message.timeStart.high >>> 0).toNumber(true) : message.timeStart;
            if (message.timeEnd != null && message.hasOwnProperty("timeEnd"))
                if (typeof message.timeEnd === "number")
                    object.timeEnd = options.longs === String ? String(message.timeEnd) : message.timeEnd;
                else
                    object.timeEnd = options.longs === String ? $util.Long.prototype.toString.call(message.timeEnd) : options.longs === Number ? new $util.LongBits(message.timeEnd.low >>> 0, message.timeEnd.high >>> 0).toNumber(true) : message.timeEnd;
            if (message.layers && message.layers.length) {
                object.layers = [];
                for (let j = 0; j < message.layers.length; ++j)
                    object.layers[j] = $root.stt.Layer.toObject(message.layers[j], options);
            }
            return object;
        };

        /**
         * Converts this Tile to JSON.
         * @function toJSON
         * @memberof stt.Tile
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Tile.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for Tile
         * @function getTypeUrl
         * @memberof stt.Tile
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        Tile.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.Tile";
        };

        return Tile;
    })();

    stt.Layer = (function() {

        /**
         * Properties of a Layer.
         * @memberof stt
         * @interface ILayer
         * @property {string|null} [name] Layer name
         * @property {number|null} [extent] Layer extent
         * @property {stt.IColumnarFeatures|null} [columnar] Layer columnar
         */

        /**
         * Constructs a new Layer.
         * @memberof stt
         * @classdesc Represents a Layer.
         * @implements ILayer
         * @constructor
         * @param {stt.ILayer=} [properties] Properties to set
         */
        function Layer(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Layer name.
         * @member {string} name
         * @memberof stt.Layer
         * @instance
         */
        Layer.prototype.name = "";

        /**
         * Layer extent.
         * @member {number} extent
         * @memberof stt.Layer
         * @instance
         */
        Layer.prototype.extent = 0;

        /**
         * Layer columnar.
         * @member {stt.IColumnarFeatures|null|undefined} columnar
         * @memberof stt.Layer
         * @instance
         */
        Layer.prototype.columnar = null;

        /**
         * Creates a new Layer instance using the specified properties.
         * @function create
         * @memberof stt.Layer
         * @static
         * @param {stt.ILayer=} [properties] Properties to set
         * @returns {stt.Layer} Layer instance
         */
        Layer.create = function create(properties) {
            return new Layer(properties);
        };

        /**
         * Encodes the specified Layer message. Does not implicitly {@link stt.Layer.verify|verify} messages.
         * @function encode
         * @memberof stt.Layer
         * @static
         * @param {stt.ILayer} message Layer message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Layer.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.name != null && Object.hasOwnProperty.call(message, "name"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.name);
            if (message.extent != null && Object.hasOwnProperty.call(message, "extent"))
                writer.uint32(/* id 2, wireType 0 =*/16).uint32(message.extent);
            if (message.columnar != null && Object.hasOwnProperty.call(message, "columnar"))
                $root.stt.ColumnarFeatures.encode(message.columnar, writer.uint32(/* id 4, wireType 2 =*/34).fork()).ldelim();
            return writer;
        };

        /**
         * Encodes the specified Layer message, length delimited. Does not implicitly {@link stt.Layer.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.Layer
         * @static
         * @param {stt.ILayer} message Layer message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Layer.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a Layer message from the specified reader or buffer.
         * @function decode
         * @memberof stt.Layer
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.Layer} Layer
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Layer.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.Layer();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.name = reader.string();
                        break;
                    }
                case 2: {
                        message.extent = reader.uint32();
                        break;
                    }
                case 4: {
                        message.columnar = $root.stt.ColumnarFeatures.decode(reader, reader.uint32());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a Layer message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.Layer
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.Layer} Layer
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Layer.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Layer message.
         * @function verify
         * @memberof stt.Layer
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Layer.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.name != null && message.hasOwnProperty("name"))
                if (!$util.isString(message.name))
                    return "name: string expected";
            if (message.extent != null && message.hasOwnProperty("extent"))
                if (!$util.isInteger(message.extent))
                    return "extent: integer expected";
            if (message.columnar != null && message.hasOwnProperty("columnar")) {
                let error = $root.stt.ColumnarFeatures.verify(message.columnar);
                if (error)
                    return "columnar." + error;
            }
            return null;
        };

        /**
         * Creates a Layer message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.Layer
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.Layer} Layer
         */
        Layer.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.Layer)
                return object;
            let message = new $root.stt.Layer();
            if (object.name != null)
                message.name = String(object.name);
            if (object.extent != null)
                message.extent = object.extent >>> 0;
            if (object.columnar != null) {
                if (typeof object.columnar !== "object")
                    throw TypeError(".stt.Layer.columnar: object expected");
                message.columnar = $root.stt.ColumnarFeatures.fromObject(object.columnar);
            }
            return message;
        };

        /**
         * Creates a plain object from a Layer message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.Layer
         * @static
         * @param {stt.Layer} message Layer
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Layer.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.defaults) {
                object.name = "";
                object.extent = 0;
                object.columnar = null;
            }
            if (message.name != null && message.hasOwnProperty("name"))
                object.name = message.name;
            if (message.extent != null && message.hasOwnProperty("extent"))
                object.extent = message.extent;
            if (message.columnar != null && message.hasOwnProperty("columnar"))
                object.columnar = $root.stt.ColumnarFeatures.toObject(message.columnar, options);
            return object;
        };

        /**
         * Converts this Layer to JSON.
         * @function toJSON
         * @memberof stt.Layer
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Layer.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for Layer
         * @function getTypeUrl
         * @memberof stt.Layer
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        Layer.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.Layer";
        };

        return Layer;
    })();

    stt.Feature = (function() {

        /**
         * Properties of a Feature.
         * @memberof stt
         * @interface IFeature
         */

        /**
         * Constructs a new Feature.
         * @memberof stt
         * @classdesc Represents a Feature.
         * @implements IFeature
         * @constructor
         * @param {stt.IFeature=} [properties] Properties to set
         */
        function Feature(properties) {
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Creates a new Feature instance using the specified properties.
         * @function create
         * @memberof stt.Feature
         * @static
         * @param {stt.IFeature=} [properties] Properties to set
         * @returns {stt.Feature} Feature instance
         */
        Feature.create = function create(properties) {
            return new Feature(properties);
        };

        /**
         * Encodes the specified Feature message. Does not implicitly {@link stt.Feature.verify|verify} messages.
         * @function encode
         * @memberof stt.Feature
         * @static
         * @param {stt.IFeature} message Feature message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Feature.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            return writer;
        };

        /**
         * Encodes the specified Feature message, length delimited. Does not implicitly {@link stt.Feature.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.Feature
         * @static
         * @param {stt.IFeature} message Feature message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Feature.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a Feature message from the specified reader or buffer.
         * @function decode
         * @memberof stt.Feature
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.Feature} Feature
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Feature.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.Feature();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a Feature message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.Feature
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.Feature} Feature
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Feature.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Feature message.
         * @function verify
         * @memberof stt.Feature
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Feature.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            return null;
        };

        /**
         * Creates a Feature message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.Feature
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.Feature} Feature
         */
        Feature.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.Feature)
                return object;
            return new $root.stt.Feature();
        };

        /**
         * Creates a plain object from a Feature message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.Feature
         * @static
         * @param {stt.Feature} message Feature
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Feature.toObject = function toObject() {
            return {};
        };

        /**
         * Converts this Feature to JSON.
         * @function toJSON
         * @memberof stt.Feature
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Feature.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for Feature
         * @function getTypeUrl
         * @memberof stt.Feature
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        Feature.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.Feature";
        };

        /**
         * GeomType enum.
         * @name stt.Feature.GeomType
         * @enum {number}
         * @property {number} POINT=0 POINT value
         * @property {number} LINESTRING=1 LINESTRING value
         * @property {number} POLYGON=2 POLYGON value
         */
        Feature.GeomType = (function() {
            const valuesById = {}, values = Object.create(valuesById);
            values[valuesById[0] = "POINT"] = 0;
            values[valuesById[1] = "LINESTRING"] = 1;
            values[valuesById[2] = "POLYGON"] = 2;
            return values;
        })();

        return Feature;
    })();

    stt.ColumnarFeatures = (function() {

        /**
         * Properties of a ColumnarFeatures.
         * @memberof stt
         * @interface IColumnarFeatures
         * @property {number|null} [featureCount] ColumnarFeatures featureCount
         * @property {stt.Feature.GeomType|null} [geometryType] ColumnarFeatures geometryType
         * @property {Array.<number|Long>|null} [featureIds] ColumnarFeatures featureIds
         * @property {Array.<number>|null} [geometry] ColumnarFeatures geometry
         * @property {Array.<number>|null} [geometryOffsets] ColumnarFeatures geometryOffsets
         * @property {Array.<number|Long>|null} [startTimes] ColumnarFeatures startTimes
         * @property {Array.<number|Long>|null} [endTimes] ColumnarFeatures endTimes
         * @property {Array.<stt.INumericColumn>|null} [numericProperties] ColumnarFeatures numericProperties
         * @property {Array.<stt.ICategoricalColumn>|null} [categoricalProperties] ColumnarFeatures categoricalProperties
         * @property {Array.<number>|null} [ringOffsets] ColumnarFeatures ringOffsets
         * @property {Array.<number>|null} [ringOffsetsOffsets] ColumnarFeatures ringOffsetsOffsets
         * @property {Array.<number>|null} [altitudes] ColumnarFeatures altitudes
         * @property {Array.<number|Long>|null} [vertexTimestamps] ColumnarFeatures vertexTimestamps
         */

        /**
         * Constructs a new ColumnarFeatures.
         * @memberof stt
         * @classdesc Represents a ColumnarFeatures.
         * @implements IColumnarFeatures
         * @constructor
         * @param {stt.IColumnarFeatures=} [properties] Properties to set
         */
        function ColumnarFeatures(properties) {
            this.featureIds = [];
            this.geometry = [];
            this.geometryOffsets = [];
            this.startTimes = [];
            this.endTimes = [];
            this.numericProperties = [];
            this.categoricalProperties = [];
            this.ringOffsets = [];
            this.ringOffsetsOffsets = [];
            this.altitudes = [];
            this.vertexTimestamps = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * ColumnarFeatures featureCount.
         * @member {number} featureCount
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.featureCount = 0;

        /**
         * ColumnarFeatures geometryType.
         * @member {stt.Feature.GeomType} geometryType
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.geometryType = 0;

        /**
         * ColumnarFeatures featureIds.
         * @member {Array.<number|Long>} featureIds
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.featureIds = $util.emptyArray;

        /**
         * ColumnarFeatures geometry.
         * @member {Array.<number>} geometry
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.geometry = $util.emptyArray;

        /**
         * ColumnarFeatures geometryOffsets.
         * @member {Array.<number>} geometryOffsets
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.geometryOffsets = $util.emptyArray;

        /**
         * ColumnarFeatures startTimes.
         * @member {Array.<number|Long>} startTimes
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.startTimes = $util.emptyArray;

        /**
         * ColumnarFeatures endTimes.
         * @member {Array.<number|Long>} endTimes
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.endTimes = $util.emptyArray;

        /**
         * ColumnarFeatures numericProperties.
         * @member {Array.<stt.INumericColumn>} numericProperties
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.numericProperties = $util.emptyArray;

        /**
         * ColumnarFeatures categoricalProperties.
         * @member {Array.<stt.ICategoricalColumn>} categoricalProperties
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.categoricalProperties = $util.emptyArray;

        /**
         * ColumnarFeatures ringOffsets.
         * @member {Array.<number>} ringOffsets
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.ringOffsets = $util.emptyArray;

        /**
         * ColumnarFeatures ringOffsetsOffsets.
         * @member {Array.<number>} ringOffsetsOffsets
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.ringOffsetsOffsets = $util.emptyArray;

        /**
         * ColumnarFeatures altitudes.
         * @member {Array.<number>} altitudes
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.altitudes = $util.emptyArray;

        /**
         * ColumnarFeatures vertexTimestamps.
         * @member {Array.<number|Long>} vertexTimestamps
         * @memberof stt.ColumnarFeatures
         * @instance
         */
        ColumnarFeatures.prototype.vertexTimestamps = $util.emptyArray;

        /**
         * Creates a new ColumnarFeatures instance using the specified properties.
         * @function create
         * @memberof stt.ColumnarFeatures
         * @static
         * @param {stt.IColumnarFeatures=} [properties] Properties to set
         * @returns {stt.ColumnarFeatures} ColumnarFeatures instance
         */
        ColumnarFeatures.create = function create(properties) {
            return new ColumnarFeatures(properties);
        };

        /**
         * Encodes the specified ColumnarFeatures message. Does not implicitly {@link stt.ColumnarFeatures.verify|verify} messages.
         * @function encode
         * @memberof stt.ColumnarFeatures
         * @static
         * @param {stt.IColumnarFeatures} message ColumnarFeatures message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ColumnarFeatures.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.featureCount != null && Object.hasOwnProperty.call(message, "featureCount"))
                writer.uint32(/* id 1, wireType 0 =*/8).uint32(message.featureCount);
            if (message.geometryType != null && Object.hasOwnProperty.call(message, "geometryType"))
                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.geometryType);
            if (message.featureIds != null && message.featureIds.length) {
                writer.uint32(/* id 3, wireType 2 =*/26).fork();
                for (let i = 0; i < message.featureIds.length; ++i)
                    writer.uint64(message.featureIds[i]);
                writer.ldelim();
            }
            if (message.geometry != null && message.geometry.length) {
                writer.uint32(/* id 4, wireType 2 =*/34).fork();
                for (let i = 0; i < message.geometry.length; ++i)
                    writer.sint32(message.geometry[i]);
                writer.ldelim();
            }
            if (message.geometryOffsets != null && message.geometryOffsets.length) {
                writer.uint32(/* id 5, wireType 2 =*/42).fork();
                for (let i = 0; i < message.geometryOffsets.length; ++i)
                    writer.uint32(message.geometryOffsets[i]);
                writer.ldelim();
            }
            if (message.startTimes != null && message.startTimes.length) {
                writer.uint32(/* id 6, wireType 2 =*/50).fork();
                for (let i = 0; i < message.startTimes.length; ++i)
                    writer.sint64(message.startTimes[i]);
                writer.ldelim();
            }
            if (message.endTimes != null && message.endTimes.length) {
                writer.uint32(/* id 7, wireType 2 =*/58).fork();
                for (let i = 0; i < message.endTimes.length; ++i)
                    writer.sint64(message.endTimes[i]);
                writer.ldelim();
            }
            if (message.numericProperties != null && message.numericProperties.length)
                for (let i = 0; i < message.numericProperties.length; ++i)
                    $root.stt.NumericColumn.encode(message.numericProperties[i], writer.uint32(/* id 8, wireType 2 =*/66).fork()).ldelim();
            if (message.categoricalProperties != null && message.categoricalProperties.length)
                for (let i = 0; i < message.categoricalProperties.length; ++i)
                    $root.stt.CategoricalColumn.encode(message.categoricalProperties[i], writer.uint32(/* id 9, wireType 2 =*/74).fork()).ldelim();
            if (message.ringOffsets != null && message.ringOffsets.length) {
                writer.uint32(/* id 10, wireType 2 =*/82).fork();
                for (let i = 0; i < message.ringOffsets.length; ++i)
                    writer.uint32(message.ringOffsets[i]);
                writer.ldelim();
            }
            if (message.ringOffsetsOffsets != null && message.ringOffsetsOffsets.length) {
                writer.uint32(/* id 11, wireType 2 =*/90).fork();
                for (let i = 0; i < message.ringOffsetsOffsets.length; ++i)
                    writer.uint32(message.ringOffsetsOffsets[i]);
                writer.ldelim();
            }
            if (message.altitudes != null && message.altitudes.length) {
                writer.uint32(/* id 12, wireType 2 =*/98).fork();
                for (let i = 0; i < message.altitudes.length; ++i)
                    writer.float(message.altitudes[i]);
                writer.ldelim();
            }
            if (message.vertexTimestamps != null && message.vertexTimestamps.length) {
                writer.uint32(/* id 13, wireType 2 =*/106).fork();
                for (let i = 0; i < message.vertexTimestamps.length; ++i)
                    writer.sint64(message.vertexTimestamps[i]);
                writer.ldelim();
            }
            return writer;
        };

        /**
         * Encodes the specified ColumnarFeatures message, length delimited. Does not implicitly {@link stt.ColumnarFeatures.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.ColumnarFeatures
         * @static
         * @param {stt.IColumnarFeatures} message ColumnarFeatures message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ColumnarFeatures.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a ColumnarFeatures message from the specified reader or buffer.
         * @function decode
         * @memberof stt.ColumnarFeatures
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.ColumnarFeatures} ColumnarFeatures
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ColumnarFeatures.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.ColumnarFeatures();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.featureCount = reader.uint32();
                        break;
                    }
                case 2: {
                        message.geometryType = reader.int32();
                        break;
                    }
                case 3: {
                        if (!(message.featureIds && message.featureIds.length))
                            message.featureIds = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.featureIds.push(reader.uint64());
                        } else
                            message.featureIds.push(reader.uint64());
                        break;
                    }
                case 4: {
                        if (!(message.geometry && message.geometry.length))
                            message.geometry = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.geometry.push(reader.sint32());
                        } else
                            message.geometry.push(reader.sint32());
                        break;
                    }
                case 5: {
                        if (!(message.geometryOffsets && message.geometryOffsets.length))
                            message.geometryOffsets = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.geometryOffsets.push(reader.uint32());
                        } else
                            message.geometryOffsets.push(reader.uint32());
                        break;
                    }
                case 6: {
                        if (!(message.startTimes && message.startTimes.length))
                            message.startTimes = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.startTimes.push(reader.sint64());
                        } else
                            message.startTimes.push(reader.sint64());
                        break;
                    }
                case 7: {
                        if (!(message.endTimes && message.endTimes.length))
                            message.endTimes = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.endTimes.push(reader.sint64());
                        } else
                            message.endTimes.push(reader.sint64());
                        break;
                    }
                case 8: {
                        if (!(message.numericProperties && message.numericProperties.length))
                            message.numericProperties = [];
                        message.numericProperties.push($root.stt.NumericColumn.decode(reader, reader.uint32()));
                        break;
                    }
                case 9: {
                        if (!(message.categoricalProperties && message.categoricalProperties.length))
                            message.categoricalProperties = [];
                        message.categoricalProperties.push($root.stt.CategoricalColumn.decode(reader, reader.uint32()));
                        break;
                    }
                case 10: {
                        if (!(message.ringOffsets && message.ringOffsets.length))
                            message.ringOffsets = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.ringOffsets.push(reader.uint32());
                        } else
                            message.ringOffsets.push(reader.uint32());
                        break;
                    }
                case 11: {
                        if (!(message.ringOffsetsOffsets && message.ringOffsetsOffsets.length))
                            message.ringOffsetsOffsets = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.ringOffsetsOffsets.push(reader.uint32());
                        } else
                            message.ringOffsetsOffsets.push(reader.uint32());
                        break;
                    }
                case 12: {
                        if (!(message.altitudes && message.altitudes.length))
                            message.altitudes = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.altitudes.push(reader.float());
                        } else
                            message.altitudes.push(reader.float());
                        break;
                    }
                case 13: {
                        if (!(message.vertexTimestamps && message.vertexTimestamps.length))
                            message.vertexTimestamps = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.vertexTimestamps.push(reader.sint64());
                        } else
                            message.vertexTimestamps.push(reader.sint64());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a ColumnarFeatures message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.ColumnarFeatures
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.ColumnarFeatures} ColumnarFeatures
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ColumnarFeatures.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a ColumnarFeatures message.
         * @function verify
         * @memberof stt.ColumnarFeatures
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        ColumnarFeatures.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.featureCount != null && message.hasOwnProperty("featureCount"))
                if (!$util.isInteger(message.featureCount))
                    return "featureCount: integer expected";
            if (message.geometryType != null && message.hasOwnProperty("geometryType"))
                switch (message.geometryType) {
                default:
                    return "geometryType: enum value expected";
                case 0:
                case 1:
                case 2:
                    break;
                }
            if (message.featureIds != null && message.hasOwnProperty("featureIds")) {
                if (!Array.isArray(message.featureIds))
                    return "featureIds: array expected";
                for (let i = 0; i < message.featureIds.length; ++i)
                    if (!$util.isInteger(message.featureIds[i]) && !(message.featureIds[i] && $util.isInteger(message.featureIds[i].low) && $util.isInteger(message.featureIds[i].high)))
                        return "featureIds: integer|Long[] expected";
            }
            if (message.geometry != null && message.hasOwnProperty("geometry")) {
                if (!Array.isArray(message.geometry))
                    return "geometry: array expected";
                for (let i = 0; i < message.geometry.length; ++i)
                    if (!$util.isInteger(message.geometry[i]))
                        return "geometry: integer[] expected";
            }
            if (message.geometryOffsets != null && message.hasOwnProperty("geometryOffsets")) {
                if (!Array.isArray(message.geometryOffsets))
                    return "geometryOffsets: array expected";
                for (let i = 0; i < message.geometryOffsets.length; ++i)
                    if (!$util.isInteger(message.geometryOffsets[i]))
                        return "geometryOffsets: integer[] expected";
            }
            if (message.startTimes != null && message.hasOwnProperty("startTimes")) {
                if (!Array.isArray(message.startTimes))
                    return "startTimes: array expected";
                for (let i = 0; i < message.startTimes.length; ++i)
                    if (!$util.isInteger(message.startTimes[i]) && !(message.startTimes[i] && $util.isInteger(message.startTimes[i].low) && $util.isInteger(message.startTimes[i].high)))
                        return "startTimes: integer|Long[] expected";
            }
            if (message.endTimes != null && message.hasOwnProperty("endTimes")) {
                if (!Array.isArray(message.endTimes))
                    return "endTimes: array expected";
                for (let i = 0; i < message.endTimes.length; ++i)
                    if (!$util.isInteger(message.endTimes[i]) && !(message.endTimes[i] && $util.isInteger(message.endTimes[i].low) && $util.isInteger(message.endTimes[i].high)))
                        return "endTimes: integer|Long[] expected";
            }
            if (message.numericProperties != null && message.hasOwnProperty("numericProperties")) {
                if (!Array.isArray(message.numericProperties))
                    return "numericProperties: array expected";
                for (let i = 0; i < message.numericProperties.length; ++i) {
                    let error = $root.stt.NumericColumn.verify(message.numericProperties[i]);
                    if (error)
                        return "numericProperties." + error;
                }
            }
            if (message.categoricalProperties != null && message.hasOwnProperty("categoricalProperties")) {
                if (!Array.isArray(message.categoricalProperties))
                    return "categoricalProperties: array expected";
                for (let i = 0; i < message.categoricalProperties.length; ++i) {
                    let error = $root.stt.CategoricalColumn.verify(message.categoricalProperties[i]);
                    if (error)
                        return "categoricalProperties." + error;
                }
            }
            if (message.ringOffsets != null && message.hasOwnProperty("ringOffsets")) {
                if (!Array.isArray(message.ringOffsets))
                    return "ringOffsets: array expected";
                for (let i = 0; i < message.ringOffsets.length; ++i)
                    if (!$util.isInteger(message.ringOffsets[i]))
                        return "ringOffsets: integer[] expected";
            }
            if (message.ringOffsetsOffsets != null && message.hasOwnProperty("ringOffsetsOffsets")) {
                if (!Array.isArray(message.ringOffsetsOffsets))
                    return "ringOffsetsOffsets: array expected";
                for (let i = 0; i < message.ringOffsetsOffsets.length; ++i)
                    if (!$util.isInteger(message.ringOffsetsOffsets[i]))
                        return "ringOffsetsOffsets: integer[] expected";
            }
            if (message.altitudes != null && message.hasOwnProperty("altitudes")) {
                if (!Array.isArray(message.altitudes))
                    return "altitudes: array expected";
                for (let i = 0; i < message.altitudes.length; ++i)
                    if (typeof message.altitudes[i] !== "number")
                        return "altitudes: number[] expected";
            }
            if (message.vertexTimestamps != null && message.hasOwnProperty("vertexTimestamps")) {
                if (!Array.isArray(message.vertexTimestamps))
                    return "vertexTimestamps: array expected";
                for (let i = 0; i < message.vertexTimestamps.length; ++i)
                    if (!$util.isInteger(message.vertexTimestamps[i]) && !(message.vertexTimestamps[i] && $util.isInteger(message.vertexTimestamps[i].low) && $util.isInteger(message.vertexTimestamps[i].high)))
                        return "vertexTimestamps: integer|Long[] expected";
            }
            return null;
        };

        /**
         * Creates a ColumnarFeatures message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.ColumnarFeatures
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.ColumnarFeatures} ColumnarFeatures
         */
        ColumnarFeatures.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.ColumnarFeatures)
                return object;
            let message = new $root.stt.ColumnarFeatures();
            if (object.featureCount != null)
                message.featureCount = object.featureCount >>> 0;
            switch (object.geometryType) {
            default:
                if (typeof object.geometryType === "number") {
                    message.geometryType = object.geometryType;
                    break;
                }
                break;
            case "POINT":
            case 0:
                message.geometryType = 0;
                break;
            case "LINESTRING":
            case 1:
                message.geometryType = 1;
                break;
            case "POLYGON":
            case 2:
                message.geometryType = 2;
                break;
            }
            if (object.featureIds) {
                if (!Array.isArray(object.featureIds))
                    throw TypeError(".stt.ColumnarFeatures.featureIds: array expected");
                message.featureIds = [];
                for (let i = 0; i < object.featureIds.length; ++i)
                    if ($util.Long)
                        (message.featureIds[i] = $util.Long.fromValue(object.featureIds[i])).unsigned = true;
                    else if (typeof object.featureIds[i] === "string")
                        message.featureIds[i] = parseInt(object.featureIds[i], 10);
                    else if (typeof object.featureIds[i] === "number")
                        message.featureIds[i] = object.featureIds[i];
                    else if (typeof object.featureIds[i] === "object")
                        message.featureIds[i] = new $util.LongBits(object.featureIds[i].low >>> 0, object.featureIds[i].high >>> 0).toNumber(true);
            }
            if (object.geometry) {
                if (!Array.isArray(object.geometry))
                    throw TypeError(".stt.ColumnarFeatures.geometry: array expected");
                message.geometry = [];
                for (let i = 0; i < object.geometry.length; ++i)
                    message.geometry[i] = object.geometry[i] | 0;
            }
            if (object.geometryOffsets) {
                if (!Array.isArray(object.geometryOffsets))
                    throw TypeError(".stt.ColumnarFeatures.geometryOffsets: array expected");
                message.geometryOffsets = [];
                for (let i = 0; i < object.geometryOffsets.length; ++i)
                    message.geometryOffsets[i] = object.geometryOffsets[i] >>> 0;
            }
            if (object.startTimes) {
                if (!Array.isArray(object.startTimes))
                    throw TypeError(".stt.ColumnarFeatures.startTimes: array expected");
                message.startTimes = [];
                for (let i = 0; i < object.startTimes.length; ++i)
                    if ($util.Long)
                        (message.startTimes[i] = $util.Long.fromValue(object.startTimes[i])).unsigned = false;
                    else if (typeof object.startTimes[i] === "string")
                        message.startTimes[i] = parseInt(object.startTimes[i], 10);
                    else if (typeof object.startTimes[i] === "number")
                        message.startTimes[i] = object.startTimes[i];
                    else if (typeof object.startTimes[i] === "object")
                        message.startTimes[i] = new $util.LongBits(object.startTimes[i].low >>> 0, object.startTimes[i].high >>> 0).toNumber();
            }
            if (object.endTimes) {
                if (!Array.isArray(object.endTimes))
                    throw TypeError(".stt.ColumnarFeatures.endTimes: array expected");
                message.endTimes = [];
                for (let i = 0; i < object.endTimes.length; ++i)
                    if ($util.Long)
                        (message.endTimes[i] = $util.Long.fromValue(object.endTimes[i])).unsigned = false;
                    else if (typeof object.endTimes[i] === "string")
                        message.endTimes[i] = parseInt(object.endTimes[i], 10);
                    else if (typeof object.endTimes[i] === "number")
                        message.endTimes[i] = object.endTimes[i];
                    else if (typeof object.endTimes[i] === "object")
                        message.endTimes[i] = new $util.LongBits(object.endTimes[i].low >>> 0, object.endTimes[i].high >>> 0).toNumber();
            }
            if (object.numericProperties) {
                if (!Array.isArray(object.numericProperties))
                    throw TypeError(".stt.ColumnarFeatures.numericProperties: array expected");
                message.numericProperties = [];
                for (let i = 0; i < object.numericProperties.length; ++i) {
                    if (typeof object.numericProperties[i] !== "object")
                        throw TypeError(".stt.ColumnarFeatures.numericProperties: object expected");
                    message.numericProperties[i] = $root.stt.NumericColumn.fromObject(object.numericProperties[i]);
                }
            }
            if (object.categoricalProperties) {
                if (!Array.isArray(object.categoricalProperties))
                    throw TypeError(".stt.ColumnarFeatures.categoricalProperties: array expected");
                message.categoricalProperties = [];
                for (let i = 0; i < object.categoricalProperties.length; ++i) {
                    if (typeof object.categoricalProperties[i] !== "object")
                        throw TypeError(".stt.ColumnarFeatures.categoricalProperties: object expected");
                    message.categoricalProperties[i] = $root.stt.CategoricalColumn.fromObject(object.categoricalProperties[i]);
                }
            }
            if (object.ringOffsets) {
                if (!Array.isArray(object.ringOffsets))
                    throw TypeError(".stt.ColumnarFeatures.ringOffsets: array expected");
                message.ringOffsets = [];
                for (let i = 0; i < object.ringOffsets.length; ++i)
                    message.ringOffsets[i] = object.ringOffsets[i] >>> 0;
            }
            if (object.ringOffsetsOffsets) {
                if (!Array.isArray(object.ringOffsetsOffsets))
                    throw TypeError(".stt.ColumnarFeatures.ringOffsetsOffsets: array expected");
                message.ringOffsetsOffsets = [];
                for (let i = 0; i < object.ringOffsetsOffsets.length; ++i)
                    message.ringOffsetsOffsets[i] = object.ringOffsetsOffsets[i] >>> 0;
            }
            if (object.altitudes) {
                if (!Array.isArray(object.altitudes))
                    throw TypeError(".stt.ColumnarFeatures.altitudes: array expected");
                message.altitudes = [];
                for (let i = 0; i < object.altitudes.length; ++i)
                    message.altitudes[i] = Number(object.altitudes[i]);
            }
            if (object.vertexTimestamps) {
                if (!Array.isArray(object.vertexTimestamps))
                    throw TypeError(".stt.ColumnarFeatures.vertexTimestamps: array expected");
                message.vertexTimestamps = [];
                for (let i = 0; i < object.vertexTimestamps.length; ++i)
                    if ($util.Long)
                        (message.vertexTimestamps[i] = $util.Long.fromValue(object.vertexTimestamps[i])).unsigned = false;
                    else if (typeof object.vertexTimestamps[i] === "string")
                        message.vertexTimestamps[i] = parseInt(object.vertexTimestamps[i], 10);
                    else if (typeof object.vertexTimestamps[i] === "number")
                        message.vertexTimestamps[i] = object.vertexTimestamps[i];
                    else if (typeof object.vertexTimestamps[i] === "object")
                        message.vertexTimestamps[i] = new $util.LongBits(object.vertexTimestamps[i].low >>> 0, object.vertexTimestamps[i].high >>> 0).toNumber();
            }
            return message;
        };

        /**
         * Creates a plain object from a ColumnarFeatures message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.ColumnarFeatures
         * @static
         * @param {stt.ColumnarFeatures} message ColumnarFeatures
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        ColumnarFeatures.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults) {
                object.featureIds = [];
                object.geometry = [];
                object.geometryOffsets = [];
                object.startTimes = [];
                object.endTimes = [];
                object.numericProperties = [];
                object.categoricalProperties = [];
                object.ringOffsets = [];
                object.ringOffsetsOffsets = [];
                object.altitudes = [];
                object.vertexTimestamps = [];
            }
            if (options.defaults) {
                object.featureCount = 0;
                object.geometryType = options.enums === String ? "POINT" : 0;
            }
            if (message.featureCount != null && message.hasOwnProperty("featureCount"))
                object.featureCount = message.featureCount;
            if (message.geometryType != null && message.hasOwnProperty("geometryType"))
                object.geometryType = options.enums === String ? $root.stt.Feature.GeomType[message.geometryType] === undefined ? message.geometryType : $root.stt.Feature.GeomType[message.geometryType] : message.geometryType;
            if (message.featureIds && message.featureIds.length) {
                object.featureIds = [];
                for (let j = 0; j < message.featureIds.length; ++j)
                    if (typeof message.featureIds[j] === "number")
                        object.featureIds[j] = options.longs === String ? String(message.featureIds[j]) : message.featureIds[j];
                    else
                        object.featureIds[j] = options.longs === String ? $util.Long.prototype.toString.call(message.featureIds[j]) : options.longs === Number ? new $util.LongBits(message.featureIds[j].low >>> 0, message.featureIds[j].high >>> 0).toNumber(true) : message.featureIds[j];
            }
            if (message.geometry && message.geometry.length) {
                object.geometry = [];
                for (let j = 0; j < message.geometry.length; ++j)
                    object.geometry[j] = message.geometry[j];
            }
            if (message.geometryOffsets && message.geometryOffsets.length) {
                object.geometryOffsets = [];
                for (let j = 0; j < message.geometryOffsets.length; ++j)
                    object.geometryOffsets[j] = message.geometryOffsets[j];
            }
            if (message.startTimes && message.startTimes.length) {
                object.startTimes = [];
                for (let j = 0; j < message.startTimes.length; ++j)
                    if (typeof message.startTimes[j] === "number")
                        object.startTimes[j] = options.longs === String ? String(message.startTimes[j]) : message.startTimes[j];
                    else
                        object.startTimes[j] = options.longs === String ? $util.Long.prototype.toString.call(message.startTimes[j]) : options.longs === Number ? new $util.LongBits(message.startTimes[j].low >>> 0, message.startTimes[j].high >>> 0).toNumber() : message.startTimes[j];
            }
            if (message.endTimes && message.endTimes.length) {
                object.endTimes = [];
                for (let j = 0; j < message.endTimes.length; ++j)
                    if (typeof message.endTimes[j] === "number")
                        object.endTimes[j] = options.longs === String ? String(message.endTimes[j]) : message.endTimes[j];
                    else
                        object.endTimes[j] = options.longs === String ? $util.Long.prototype.toString.call(message.endTimes[j]) : options.longs === Number ? new $util.LongBits(message.endTimes[j].low >>> 0, message.endTimes[j].high >>> 0).toNumber() : message.endTimes[j];
            }
            if (message.numericProperties && message.numericProperties.length) {
                object.numericProperties = [];
                for (let j = 0; j < message.numericProperties.length; ++j)
                    object.numericProperties[j] = $root.stt.NumericColumn.toObject(message.numericProperties[j], options);
            }
            if (message.categoricalProperties && message.categoricalProperties.length) {
                object.categoricalProperties = [];
                for (let j = 0; j < message.categoricalProperties.length; ++j)
                    object.categoricalProperties[j] = $root.stt.CategoricalColumn.toObject(message.categoricalProperties[j], options);
            }
            if (message.ringOffsets && message.ringOffsets.length) {
                object.ringOffsets = [];
                for (let j = 0; j < message.ringOffsets.length; ++j)
                    object.ringOffsets[j] = message.ringOffsets[j];
            }
            if (message.ringOffsetsOffsets && message.ringOffsetsOffsets.length) {
                object.ringOffsetsOffsets = [];
                for (let j = 0; j < message.ringOffsetsOffsets.length; ++j)
                    object.ringOffsetsOffsets[j] = message.ringOffsetsOffsets[j];
            }
            if (message.altitudes && message.altitudes.length) {
                object.altitudes = [];
                for (let j = 0; j < message.altitudes.length; ++j)
                    object.altitudes[j] = options.json && !isFinite(message.altitudes[j]) ? String(message.altitudes[j]) : message.altitudes[j];
            }
            if (message.vertexTimestamps && message.vertexTimestamps.length) {
                object.vertexTimestamps = [];
                for (let j = 0; j < message.vertexTimestamps.length; ++j)
                    if (typeof message.vertexTimestamps[j] === "number")
                        object.vertexTimestamps[j] = options.longs === String ? String(message.vertexTimestamps[j]) : message.vertexTimestamps[j];
                    else
                        object.vertexTimestamps[j] = options.longs === String ? $util.Long.prototype.toString.call(message.vertexTimestamps[j]) : options.longs === Number ? new $util.LongBits(message.vertexTimestamps[j].low >>> 0, message.vertexTimestamps[j].high >>> 0).toNumber() : message.vertexTimestamps[j];
            }
            return object;
        };

        /**
         * Converts this ColumnarFeatures to JSON.
         * @function toJSON
         * @memberof stt.ColumnarFeatures
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ColumnarFeatures.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for ColumnarFeatures
         * @function getTypeUrl
         * @memberof stt.ColumnarFeatures
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        ColumnarFeatures.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.ColumnarFeatures";
        };

        return ColumnarFeatures;
    })();

    stt.NumericColumn = (function() {

        /**
         * Properties of a NumericColumn.
         * @memberof stt
         * @interface INumericColumn
         * @property {string|null} [name] NumericColumn name
         * @property {Array.<number>|null} [values] NumericColumn values
         * @property {Array.<number>|null} [valuesF64] NumericColumn valuesF64
         */

        /**
         * Constructs a new NumericColumn.
         * @memberof stt
         * @classdesc Represents a NumericColumn.
         * @implements INumericColumn
         * @constructor
         * @param {stt.INumericColumn=} [properties] Properties to set
         */
        function NumericColumn(properties) {
            this.values = [];
            this.valuesF64 = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * NumericColumn name.
         * @member {string} name
         * @memberof stt.NumericColumn
         * @instance
         */
        NumericColumn.prototype.name = "";

        /**
         * NumericColumn values.
         * @member {Array.<number>} values
         * @memberof stt.NumericColumn
         * @instance
         */
        NumericColumn.prototype.values = $util.emptyArray;

        /**
         * NumericColumn valuesF64.
         * @member {Array.<number>} valuesF64
         * @memberof stt.NumericColumn
         * @instance
         */
        NumericColumn.prototype.valuesF64 = $util.emptyArray;

        /**
         * Creates a new NumericColumn instance using the specified properties.
         * @function create
         * @memberof stt.NumericColumn
         * @static
         * @param {stt.INumericColumn=} [properties] Properties to set
         * @returns {stt.NumericColumn} NumericColumn instance
         */
        NumericColumn.create = function create(properties) {
            return new NumericColumn(properties);
        };

        /**
         * Encodes the specified NumericColumn message. Does not implicitly {@link stt.NumericColumn.verify|verify} messages.
         * @function encode
         * @memberof stt.NumericColumn
         * @static
         * @param {stt.INumericColumn} message NumericColumn message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        NumericColumn.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.name != null && Object.hasOwnProperty.call(message, "name"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.name);
            if (message.values != null && message.values.length) {
                writer.uint32(/* id 2, wireType 2 =*/18).fork();
                for (let i = 0; i < message.values.length; ++i)
                    writer.float(message.values[i]);
                writer.ldelim();
            }
            if (message.valuesF64 != null && message.valuesF64.length) {
                writer.uint32(/* id 3, wireType 2 =*/26).fork();
                for (let i = 0; i < message.valuesF64.length; ++i)
                    writer.double(message.valuesF64[i]);
                writer.ldelim();
            }
            return writer;
        };

        /**
         * Encodes the specified NumericColumn message, length delimited. Does not implicitly {@link stt.NumericColumn.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.NumericColumn
         * @static
         * @param {stt.INumericColumn} message NumericColumn message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        NumericColumn.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a NumericColumn message from the specified reader or buffer.
         * @function decode
         * @memberof stt.NumericColumn
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.NumericColumn} NumericColumn
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        NumericColumn.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.NumericColumn();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.name = reader.string();
                        break;
                    }
                case 2: {
                        if (!(message.values && message.values.length))
                            message.values = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.values.push(reader.float());
                        } else
                            message.values.push(reader.float());
                        break;
                    }
                case 3: {
                        if (!(message.valuesF64 && message.valuesF64.length))
                            message.valuesF64 = [];
                        if ((tag & 7) === 2) {
                            let end2 = reader.uint32() + reader.pos;
                            while (reader.pos < end2)
                                message.valuesF64.push(reader.double());
                        } else
                            message.valuesF64.push(reader.double());
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a NumericColumn message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.NumericColumn
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.NumericColumn} NumericColumn
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        NumericColumn.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a NumericColumn message.
         * @function verify
         * @memberof stt.NumericColumn
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        NumericColumn.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.name != null && message.hasOwnProperty("name"))
                if (!$util.isString(message.name))
                    return "name: string expected";
            if (message.values != null && message.hasOwnProperty("values")) {
                if (!Array.isArray(message.values))
                    return "values: array expected";
                for (let i = 0; i < message.values.length; ++i)
                    if (typeof message.values[i] !== "number")
                        return "values: number[] expected";
            }
            if (message.valuesF64 != null && message.hasOwnProperty("valuesF64")) {
                if (!Array.isArray(message.valuesF64))
                    return "valuesF64: array expected";
                for (let i = 0; i < message.valuesF64.length; ++i)
                    if (typeof message.valuesF64[i] !== "number")
                        return "valuesF64: number[] expected";
            }
            return null;
        };

        /**
         * Creates a NumericColumn message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.NumericColumn
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.NumericColumn} NumericColumn
         */
        NumericColumn.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.NumericColumn)
                return object;
            let message = new $root.stt.NumericColumn();
            if (object.name != null)
                message.name = String(object.name);
            if (object.values) {
                if (!Array.isArray(object.values))
                    throw TypeError(".stt.NumericColumn.values: array expected");
                message.values = [];
                for (let i = 0; i < object.values.length; ++i)
                    message.values[i] = Number(object.values[i]);
            }
            if (object.valuesF64) {
                if (!Array.isArray(object.valuesF64))
                    throw TypeError(".stt.NumericColumn.valuesF64: array expected");
                message.valuesF64 = [];
                for (let i = 0; i < object.valuesF64.length; ++i)
                    message.valuesF64[i] = Number(object.valuesF64[i]);
            }
            return message;
        };

        /**
         * Creates a plain object from a NumericColumn message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.NumericColumn
         * @static
         * @param {stt.NumericColumn} message NumericColumn
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        NumericColumn.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults) {
                object.values = [];
                object.valuesF64 = [];
            }
            if (options.defaults)
                object.name = "";
            if (message.name != null && message.hasOwnProperty("name"))
                object.name = message.name;
            if (message.values && message.values.length) {
                object.values = [];
                for (let j = 0; j < message.values.length; ++j)
                    object.values[j] = options.json && !isFinite(message.values[j]) ? String(message.values[j]) : message.values[j];
            }
            if (message.valuesF64 && message.valuesF64.length) {
                object.valuesF64 = [];
                for (let j = 0; j < message.valuesF64.length; ++j)
                    object.valuesF64[j] = options.json && !isFinite(message.valuesF64[j]) ? String(message.valuesF64[j]) : message.valuesF64[j];
            }
            return object;
        };

        /**
         * Converts this NumericColumn to JSON.
         * @function toJSON
         * @memberof stt.NumericColumn
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        NumericColumn.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for NumericColumn
         * @function getTypeUrl
         * @memberof stt.NumericColumn
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        NumericColumn.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.NumericColumn";
        };

        return NumericColumn;
    })();

    stt.CategoricalColumn = (function() {

        /**
         * Properties of a CategoricalColumn.
         * @memberof stt
         * @interface ICategoricalColumn
         * @property {string|null} [name] CategoricalColumn name
         * @property {Array.<string>|null} [categories] CategoricalColumn categories
         * @property {Uint8Array|null} [indices] CategoricalColumn indices
         */

        /**
         * Constructs a new CategoricalColumn.
         * @memberof stt
         * @classdesc Represents a CategoricalColumn.
         * @implements ICategoricalColumn
         * @constructor
         * @param {stt.ICategoricalColumn=} [properties] Properties to set
         */
        function CategoricalColumn(properties) {
            this.categories = [];
            if (properties)
                for (let keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null)
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * CategoricalColumn name.
         * @member {string} name
         * @memberof stt.CategoricalColumn
         * @instance
         */
        CategoricalColumn.prototype.name = "";

        /**
         * CategoricalColumn categories.
         * @member {Array.<string>} categories
         * @memberof stt.CategoricalColumn
         * @instance
         */
        CategoricalColumn.prototype.categories = $util.emptyArray;

        /**
         * CategoricalColumn indices.
         * @member {Uint8Array} indices
         * @memberof stt.CategoricalColumn
         * @instance
         */
        CategoricalColumn.prototype.indices = $util.newBuffer([]);

        /**
         * Creates a new CategoricalColumn instance using the specified properties.
         * @function create
         * @memberof stt.CategoricalColumn
         * @static
         * @param {stt.ICategoricalColumn=} [properties] Properties to set
         * @returns {stt.CategoricalColumn} CategoricalColumn instance
         */
        CategoricalColumn.create = function create(properties) {
            return new CategoricalColumn(properties);
        };

        /**
         * Encodes the specified CategoricalColumn message. Does not implicitly {@link stt.CategoricalColumn.verify|verify} messages.
         * @function encode
         * @memberof stt.CategoricalColumn
         * @static
         * @param {stt.ICategoricalColumn} message CategoricalColumn message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CategoricalColumn.encode = function encode(message, writer) {
            if (!writer)
                writer = $Writer.create();
            if (message.name != null && Object.hasOwnProperty.call(message, "name"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.name);
            if (message.categories != null && message.categories.length)
                for (let i = 0; i < message.categories.length; ++i)
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.categories[i]);
            if (message.indices != null && Object.hasOwnProperty.call(message, "indices"))
                writer.uint32(/* id 3, wireType 2 =*/26).bytes(message.indices);
            return writer;
        };

        /**
         * Encodes the specified CategoricalColumn message, length delimited. Does not implicitly {@link stt.CategoricalColumn.verify|verify} messages.
         * @function encodeDelimited
         * @memberof stt.CategoricalColumn
         * @static
         * @param {stt.ICategoricalColumn} message CategoricalColumn message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CategoricalColumn.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer).ldelim();
        };

        /**
         * Decodes a CategoricalColumn message from the specified reader or buffer.
         * @function decode
         * @memberof stt.CategoricalColumn
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {stt.CategoricalColumn} CategoricalColumn
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CategoricalColumn.decode = function decode(reader, length, error) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            let end = length === undefined ? reader.len : reader.pos + length, message = new $root.stt.CategoricalColumn();
            while (reader.pos < end) {
                let tag = reader.uint32();
                if (tag === error)
                    break;
                switch (tag >>> 3) {
                case 1: {
                        message.name = reader.string();
                        break;
                    }
                case 2: {
                        if (!(message.categories && message.categories.length))
                            message.categories = [];
                        message.categories.push(reader.string());
                        break;
                    }
                case 3: {
                        message.indices = reader.bytes();
                        break;
                    }
                default:
                    reader.skipType(tag & 7);
                    break;
                }
            }
            return message;
        };

        /**
         * Decodes a CategoricalColumn message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof stt.CategoricalColumn
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {stt.CategoricalColumn} CategoricalColumn
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CategoricalColumn.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CategoricalColumn message.
         * @function verify
         * @memberof stt.CategoricalColumn
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CategoricalColumn.verify = function verify(message) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (message.name != null && message.hasOwnProperty("name"))
                if (!$util.isString(message.name))
                    return "name: string expected";
            if (message.categories != null && message.hasOwnProperty("categories")) {
                if (!Array.isArray(message.categories))
                    return "categories: array expected";
                for (let i = 0; i < message.categories.length; ++i)
                    if (!$util.isString(message.categories[i]))
                        return "categories: string[] expected";
            }
            if (message.indices != null && message.hasOwnProperty("indices"))
                if (!(message.indices && typeof message.indices.length === "number" || $util.isString(message.indices)))
                    return "indices: buffer expected";
            return null;
        };

        /**
         * Creates a CategoricalColumn message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof stt.CategoricalColumn
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {stt.CategoricalColumn} CategoricalColumn
         */
        CategoricalColumn.fromObject = function fromObject(object) {
            if (object instanceof $root.stt.CategoricalColumn)
                return object;
            let message = new $root.stt.CategoricalColumn();
            if (object.name != null)
                message.name = String(object.name);
            if (object.categories) {
                if (!Array.isArray(object.categories))
                    throw TypeError(".stt.CategoricalColumn.categories: array expected");
                message.categories = [];
                for (let i = 0; i < object.categories.length; ++i)
                    message.categories[i] = String(object.categories[i]);
            }
            if (object.indices != null)
                if (typeof object.indices === "string")
                    $util.base64.decode(object.indices, message.indices = $util.newBuffer($util.base64.length(object.indices)), 0);
                else if (object.indices.length >= 0)
                    message.indices = object.indices;
            return message;
        };

        /**
         * Creates a plain object from a CategoricalColumn message. Also converts values to other types if specified.
         * @function toObject
         * @memberof stt.CategoricalColumn
         * @static
         * @param {stt.CategoricalColumn} message CategoricalColumn
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CategoricalColumn.toObject = function toObject(message, options) {
            if (!options)
                options = {};
            let object = {};
            if (options.arrays || options.defaults)
                object.categories = [];
            if (options.defaults) {
                object.name = "";
                if (options.bytes === String)
                    object.indices = "";
                else {
                    object.indices = [];
                    if (options.bytes !== Array)
                        object.indices = $util.newBuffer(object.indices);
                }
            }
            if (message.name != null && message.hasOwnProperty("name"))
                object.name = message.name;
            if (message.categories && message.categories.length) {
                object.categories = [];
                for (let j = 0; j < message.categories.length; ++j)
                    object.categories[j] = message.categories[j];
            }
            if (message.indices != null && message.hasOwnProperty("indices"))
                object.indices = options.bytes === String ? $util.base64.encode(message.indices, 0, message.indices.length) : options.bytes === Array ? Array.prototype.slice.call(message.indices) : message.indices;
            return object;
        };

        /**
         * Converts this CategoricalColumn to JSON.
         * @function toJSON
         * @memberof stt.CategoricalColumn
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CategoricalColumn.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the default type url for CategoricalColumn
         * @function getTypeUrl
         * @memberof stt.CategoricalColumn
         * @static
         * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns {string} The default type url
         */
        CategoricalColumn.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
            if (typeUrlPrefix === undefined) {
                typeUrlPrefix = "type.googleapis.com";
            }
            return typeUrlPrefix + "/stt.CategoricalColumn";
        };

        return CategoricalColumn;
    })();

    return stt;
})();

export { $root as default };
