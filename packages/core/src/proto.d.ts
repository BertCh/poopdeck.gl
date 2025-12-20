import * as $protobuf from "protobufjs";
import Long = require("long");
/** Namespace stt. */
export namespace stt {

    /** Properties of an Index. */
    interface IIndex {

        /** Index tiles */
        tiles?: (stt.ITileEntry[]|null);

        /** Index spatial */
        spatial?: (stt.ISpatialIndex|null);

        /** Index temporal */
        temporal?: (stt.ITemporalIndex|null);
    }

    /** Represents an Index. */
    class Index implements IIndex {

        /**
         * Constructs a new Index.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.IIndex);

        /** Index tiles. */
        public tiles: stt.ITileEntry[];

        /** Index spatial. */
        public spatial?: (stt.ISpatialIndex|null);

        /** Index temporal. */
        public temporal?: (stt.ITemporalIndex|null);

        /**
         * Creates a new Index instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Index instance
         */
        public static create(properties?: stt.IIndex): stt.Index;

        /**
         * Encodes the specified Index message. Does not implicitly {@link stt.Index.verify|verify} messages.
         * @param message Index message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.IIndex, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Index message, length delimited. Does not implicitly {@link stt.Index.verify|verify} messages.
         * @param message Index message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.IIndex, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes an Index message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns Index
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.Index;

        /**
         * Decodes an Index message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns Index
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.Index;

        /**
         * Verifies an Index message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates an Index message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Index
         */
        public static fromObject(object: { [k: string]: any }): stt.Index;

        /**
         * Creates a plain object from an Index message. Also converts values to other types if specified.
         * @param message Index
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.Index, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Index to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for Index
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a TileEntry. */
    interface ITileEntry {

        /** TileEntry zoom */
        zoom?: (number|null);

        /** TileEntry x */
        x?: (number|null);

        /** TileEntry y */
        y?: (number|null);

        /** TileEntry timeStart */
        timeStart?: (number|Long|null);

        /** TileEntry timeEnd */
        timeEnd?: (number|Long|null);

        /** TileEntry offset */
        offset?: (number|Long|null);

        /** TileEntry length */
        length?: (number|null);

        /** TileEntry featureCount */
        featureCount?: (number|null);

        /** TileEntry compression */
        compression?: (stt.TileEntry.Compression|null);

        /** TileEntry uncompressedSize */
        uncompressedSize?: (number|null);
    }

    /** Represents a TileEntry. */
    class TileEntry implements ITileEntry {

        /**
         * Constructs a new TileEntry.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.ITileEntry);

        /** TileEntry zoom. */
        public zoom: number;

        /** TileEntry x. */
        public x: number;

        /** TileEntry y. */
        public y: number;

        /** TileEntry timeStart. */
        public timeStart: (number|Long);

        /** TileEntry timeEnd. */
        public timeEnd: (number|Long);

        /** TileEntry offset. */
        public offset: (number|Long);

        /** TileEntry length. */
        public length: number;

        /** TileEntry featureCount. */
        public featureCount: number;

        /** TileEntry compression. */
        public compression: stt.TileEntry.Compression;

        /** TileEntry uncompressedSize. */
        public uncompressedSize: number;

        /**
         * Creates a new TileEntry instance using the specified properties.
         * @param [properties] Properties to set
         * @returns TileEntry instance
         */
        public static create(properties?: stt.ITileEntry): stt.TileEntry;

        /**
         * Encodes the specified TileEntry message. Does not implicitly {@link stt.TileEntry.verify|verify} messages.
         * @param message TileEntry message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.ITileEntry, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified TileEntry message, length delimited. Does not implicitly {@link stt.TileEntry.verify|verify} messages.
         * @param message TileEntry message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.ITileEntry, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a TileEntry message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns TileEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.TileEntry;

        /**
         * Decodes a TileEntry message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns TileEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.TileEntry;

        /**
         * Verifies a TileEntry message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a TileEntry message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns TileEntry
         */
        public static fromObject(object: { [k: string]: any }): stt.TileEntry;

        /**
         * Creates a plain object from a TileEntry message. Also converts values to other types if specified.
         * @param message TileEntry
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.TileEntry, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this TileEntry to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for TileEntry
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    namespace TileEntry {

        /** Compression enum. */
        enum Compression {
            NONE = 0,
            GZIP = 1,
            BROTLI = 2
        }
    }

    /** Properties of a SpatialIndex. */
    interface ISpatialIndex {

        /** SpatialIndex hilbertIds */
        hilbertIds?: ((number|Long)[]|null);

        /** SpatialIndex tileIndices */
        tileIndices?: (number[]|null);

        /** SpatialIndex zoomOffsets */
        zoomOffsets?: (number[]|null);
    }

    /** Represents a SpatialIndex. */
    class SpatialIndex implements ISpatialIndex {

        /**
         * Constructs a new SpatialIndex.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.ISpatialIndex);

        /** SpatialIndex hilbertIds. */
        public hilbertIds: (number|Long)[];

        /** SpatialIndex tileIndices. */
        public tileIndices: number[];

        /** SpatialIndex zoomOffsets. */
        public zoomOffsets: number[];

        /**
         * Creates a new SpatialIndex instance using the specified properties.
         * @param [properties] Properties to set
         * @returns SpatialIndex instance
         */
        public static create(properties?: stt.ISpatialIndex): stt.SpatialIndex;

        /**
         * Encodes the specified SpatialIndex message. Does not implicitly {@link stt.SpatialIndex.verify|verify} messages.
         * @param message SpatialIndex message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.ISpatialIndex, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified SpatialIndex message, length delimited. Does not implicitly {@link stt.SpatialIndex.verify|verify} messages.
         * @param message SpatialIndex message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.ISpatialIndex, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a SpatialIndex message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns SpatialIndex
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.SpatialIndex;

        /**
         * Decodes a SpatialIndex message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns SpatialIndex
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.SpatialIndex;

        /**
         * Verifies a SpatialIndex message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a SpatialIndex message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns SpatialIndex
         */
        public static fromObject(object: { [k: string]: any }): stt.SpatialIndex;

        /**
         * Creates a plain object from a SpatialIndex message. Also converts values to other types if specified.
         * @param message SpatialIndex
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.SpatialIndex, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this SpatialIndex to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for SpatialIndex
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a TemporalIndex. */
    interface ITemporalIndex {

        /** TemporalIndex timestamps */
        timestamps?: ((number|Long)[]|null);

        /** TemporalIndex tileRefOffsets */
        tileRefOffsets?: (number[]|null);

        /** TemporalIndex tileRefs */
        tileRefs?: (number[]|null);
    }

    /** Represents a TemporalIndex. */
    class TemporalIndex implements ITemporalIndex {

        /**
         * Constructs a new TemporalIndex.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.ITemporalIndex);

        /** TemporalIndex timestamps. */
        public timestamps: (number|Long)[];

        /** TemporalIndex tileRefOffsets. */
        public tileRefOffsets: number[];

        /** TemporalIndex tileRefs. */
        public tileRefs: number[];

        /**
         * Creates a new TemporalIndex instance using the specified properties.
         * @param [properties] Properties to set
         * @returns TemporalIndex instance
         */
        public static create(properties?: stt.ITemporalIndex): stt.TemporalIndex;

        /**
         * Encodes the specified TemporalIndex message. Does not implicitly {@link stt.TemporalIndex.verify|verify} messages.
         * @param message TemporalIndex message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.ITemporalIndex, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified TemporalIndex message, length delimited. Does not implicitly {@link stt.TemporalIndex.verify|verify} messages.
         * @param message TemporalIndex message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.ITemporalIndex, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a TemporalIndex message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns TemporalIndex
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.TemporalIndex;

        /**
         * Decodes a TemporalIndex message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns TemporalIndex
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.TemporalIndex;

        /**
         * Verifies a TemporalIndex message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a TemporalIndex message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns TemporalIndex
         */
        public static fromObject(object: { [k: string]: any }): stt.TemporalIndex;

        /**
         * Creates a plain object from a TemporalIndex message. Also converts values to other types if specified.
         * @param message TemporalIndex
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.TemporalIndex, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this TemporalIndex to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for TemporalIndex
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a Metadata. */
    interface IMetadata {

        /** Metadata version */
        version?: (number|null);

        /** Metadata name */
        name?: (string|null);

        /** Metadata description */
        description?: (string|null);

        /** Metadata attribution */
        attribution?: (string|null);

        /** Metadata bounds */
        bounds?: (stt.IBoundingBox|null);

        /** Metadata timeRange */
        timeRange?: (stt.ITimeRange|null);

        /** Metadata minZoom */
        minZoom?: (number|null);

        /** Metadata maxZoom */
        maxZoom?: (number|null);

        /** Metadata layers */
        layers?: (stt.ILayerInfo[]|null);

        /** Metadata generation */
        generation?: (stt.IGenerationInfo|null);

        /** Metadata stats */
        stats?: (stt.IStatistics|null);
    }

    /** Represents a Metadata. */
    class Metadata implements IMetadata {

        /**
         * Constructs a new Metadata.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.IMetadata);

        /** Metadata version. */
        public version: number;

        /** Metadata name. */
        public name: string;

        /** Metadata description. */
        public description: string;

        /** Metadata attribution. */
        public attribution: string;

        /** Metadata bounds. */
        public bounds?: (stt.IBoundingBox|null);

        /** Metadata timeRange. */
        public timeRange?: (stt.ITimeRange|null);

        /** Metadata minZoom. */
        public minZoom: number;

        /** Metadata maxZoom. */
        public maxZoom: number;

        /** Metadata layers. */
        public layers: stt.ILayerInfo[];

        /** Metadata generation. */
        public generation?: (stt.IGenerationInfo|null);

        /** Metadata stats. */
        public stats?: (stt.IStatistics|null);

        /**
         * Creates a new Metadata instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Metadata instance
         */
        public static create(properties?: stt.IMetadata): stt.Metadata;

        /**
         * Encodes the specified Metadata message. Does not implicitly {@link stt.Metadata.verify|verify} messages.
         * @param message Metadata message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.IMetadata, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Metadata message, length delimited. Does not implicitly {@link stt.Metadata.verify|verify} messages.
         * @param message Metadata message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.IMetadata, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Metadata message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns Metadata
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.Metadata;

        /**
         * Decodes a Metadata message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns Metadata
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.Metadata;

        /**
         * Verifies a Metadata message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Metadata message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Metadata
         */
        public static fromObject(object: { [k: string]: any }): stt.Metadata;

        /**
         * Creates a plain object from a Metadata message. Also converts values to other types if specified.
         * @param message Metadata
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.Metadata, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Metadata to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for Metadata
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a BoundingBox. */
    interface IBoundingBox {

        /** BoundingBox minLon */
        minLon?: (number|null);

        /** BoundingBox minLat */
        minLat?: (number|null);

        /** BoundingBox maxLon */
        maxLon?: (number|null);

        /** BoundingBox maxLat */
        maxLat?: (number|null);
    }

    /** Represents a BoundingBox. */
    class BoundingBox implements IBoundingBox {

        /**
         * Constructs a new BoundingBox.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.IBoundingBox);

        /** BoundingBox minLon. */
        public minLon: number;

        /** BoundingBox minLat. */
        public minLat: number;

        /** BoundingBox maxLon. */
        public maxLon: number;

        /** BoundingBox maxLat. */
        public maxLat: number;

        /**
         * Creates a new BoundingBox instance using the specified properties.
         * @param [properties] Properties to set
         * @returns BoundingBox instance
         */
        public static create(properties?: stt.IBoundingBox): stt.BoundingBox;

        /**
         * Encodes the specified BoundingBox message. Does not implicitly {@link stt.BoundingBox.verify|verify} messages.
         * @param message BoundingBox message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.IBoundingBox, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified BoundingBox message, length delimited. Does not implicitly {@link stt.BoundingBox.verify|verify} messages.
         * @param message BoundingBox message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.IBoundingBox, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a BoundingBox message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns BoundingBox
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.BoundingBox;

        /**
         * Decodes a BoundingBox message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns BoundingBox
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.BoundingBox;

        /**
         * Verifies a BoundingBox message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a BoundingBox message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns BoundingBox
         */
        public static fromObject(object: { [k: string]: any }): stt.BoundingBox;

        /**
         * Creates a plain object from a BoundingBox message. Also converts values to other types if specified.
         * @param message BoundingBox
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.BoundingBox, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this BoundingBox to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for BoundingBox
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a TimeRange. */
    interface ITimeRange {

        /** TimeRange start */
        start?: (number|Long|null);

        /** TimeRange end */
        end?: (number|Long|null);

        /** TimeRange interval */
        interval?: (number|Long|null);
    }

    /** Represents a TimeRange. */
    class TimeRange implements ITimeRange {

        /**
         * Constructs a new TimeRange.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.ITimeRange);

        /** TimeRange start. */
        public start: (number|Long);

        /** TimeRange end. */
        public end: (number|Long);

        /** TimeRange interval. */
        public interval: (number|Long);

        /**
         * Creates a new TimeRange instance using the specified properties.
         * @param [properties] Properties to set
         * @returns TimeRange instance
         */
        public static create(properties?: stt.ITimeRange): stt.TimeRange;

        /**
         * Encodes the specified TimeRange message. Does not implicitly {@link stt.TimeRange.verify|verify} messages.
         * @param message TimeRange message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.ITimeRange, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified TimeRange message, length delimited. Does not implicitly {@link stt.TimeRange.verify|verify} messages.
         * @param message TimeRange message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.ITimeRange, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a TimeRange message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns TimeRange
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.TimeRange;

        /**
         * Decodes a TimeRange message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns TimeRange
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.TimeRange;

        /**
         * Verifies a TimeRange message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a TimeRange message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns TimeRange
         */
        public static fromObject(object: { [k: string]: any }): stt.TimeRange;

        /**
         * Creates a plain object from a TimeRange message. Also converts values to other types if specified.
         * @param message TimeRange
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.TimeRange, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this TimeRange to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for TimeRange
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a LayerInfo. */
    interface ILayerInfo {

        /** LayerInfo name */
        name?: (string|null);

        /** LayerInfo description */
        description?: (string|null);

        /** LayerInfo properties */
        properties?: (stt.IPropertyInfo[]|null);

        /** LayerInfo geometryTypes */
        geometryTypes?: (string[]|null);
    }

    /** Represents a LayerInfo. */
    class LayerInfo implements ILayerInfo {

        /**
         * Constructs a new LayerInfo.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.ILayerInfo);

        /** LayerInfo name. */
        public name: string;

        /** LayerInfo description. */
        public description: string;

        /** LayerInfo properties. */
        public properties: stt.IPropertyInfo[];

        /** LayerInfo geometryTypes. */
        public geometryTypes: string[];

        /**
         * Creates a new LayerInfo instance using the specified properties.
         * @param [properties] Properties to set
         * @returns LayerInfo instance
         */
        public static create(properties?: stt.ILayerInfo): stt.LayerInfo;

        /**
         * Encodes the specified LayerInfo message. Does not implicitly {@link stt.LayerInfo.verify|verify} messages.
         * @param message LayerInfo message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.ILayerInfo, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified LayerInfo message, length delimited. Does not implicitly {@link stt.LayerInfo.verify|verify} messages.
         * @param message LayerInfo message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.ILayerInfo, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a LayerInfo message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns LayerInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.LayerInfo;

        /**
         * Decodes a LayerInfo message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns LayerInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.LayerInfo;

        /**
         * Verifies a LayerInfo message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a LayerInfo message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns LayerInfo
         */
        public static fromObject(object: { [k: string]: any }): stt.LayerInfo;

        /**
         * Creates a plain object from a LayerInfo message. Also converts values to other types if specified.
         * @param message LayerInfo
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.LayerInfo, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this LayerInfo to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for LayerInfo
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a PropertyInfo. */
    interface IPropertyInfo {

        /** PropertyInfo name */
        name?: (string|null);

        /** PropertyInfo type */
        type?: (string|null);

        /** PropertyInfo description */
        description?: (string|null);

        /** PropertyInfo minValue */
        minValue?: (number|null);

        /** PropertyInfo maxValue */
        maxValue?: (number|null);
    }

    /** Represents a PropertyInfo. */
    class PropertyInfo implements IPropertyInfo {

        /**
         * Constructs a new PropertyInfo.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.IPropertyInfo);

        /** PropertyInfo name. */
        public name: string;

        /** PropertyInfo type. */
        public type: string;

        /** PropertyInfo description. */
        public description: string;

        /** PropertyInfo minValue. */
        public minValue: number;

        /** PropertyInfo maxValue. */
        public maxValue: number;

        /**
         * Creates a new PropertyInfo instance using the specified properties.
         * @param [properties] Properties to set
         * @returns PropertyInfo instance
         */
        public static create(properties?: stt.IPropertyInfo): stt.PropertyInfo;

        /**
         * Encodes the specified PropertyInfo message. Does not implicitly {@link stt.PropertyInfo.verify|verify} messages.
         * @param message PropertyInfo message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.IPropertyInfo, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified PropertyInfo message, length delimited. Does not implicitly {@link stt.PropertyInfo.verify|verify} messages.
         * @param message PropertyInfo message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.IPropertyInfo, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a PropertyInfo message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns PropertyInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.PropertyInfo;

        /**
         * Decodes a PropertyInfo message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns PropertyInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.PropertyInfo;

        /**
         * Verifies a PropertyInfo message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a PropertyInfo message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns PropertyInfo
         */
        public static fromObject(object: { [k: string]: any }): stt.PropertyInfo;

        /**
         * Creates a plain object from a PropertyInfo message. Also converts values to other types if specified.
         * @param message PropertyInfo
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.PropertyInfo, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this PropertyInfo to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for PropertyInfo
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a GenerationInfo. */
    interface IGenerationInfo {

        /** GenerationInfo tool */
        tool?: (string|null);

        /** GenerationInfo version */
        version?: (string|null);

        /** GenerationInfo timestamp */
        timestamp?: (number|Long|null);

        /** GenerationInfo source */
        source?: (string|null);

        /** GenerationInfo args */
        args?: (string[]|null);
    }

    /** Represents a GenerationInfo. */
    class GenerationInfo implements IGenerationInfo {

        /**
         * Constructs a new GenerationInfo.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.IGenerationInfo);

        /** GenerationInfo tool. */
        public tool: string;

        /** GenerationInfo version. */
        public version: string;

        /** GenerationInfo timestamp. */
        public timestamp: (number|Long);

        /** GenerationInfo source. */
        public source: string;

        /** GenerationInfo args. */
        public args: string[];

        /**
         * Creates a new GenerationInfo instance using the specified properties.
         * @param [properties] Properties to set
         * @returns GenerationInfo instance
         */
        public static create(properties?: stt.IGenerationInfo): stt.GenerationInfo;

        /**
         * Encodes the specified GenerationInfo message. Does not implicitly {@link stt.GenerationInfo.verify|verify} messages.
         * @param message GenerationInfo message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.IGenerationInfo, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified GenerationInfo message, length delimited. Does not implicitly {@link stt.GenerationInfo.verify|verify} messages.
         * @param message GenerationInfo message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.IGenerationInfo, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a GenerationInfo message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns GenerationInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.GenerationInfo;

        /**
         * Decodes a GenerationInfo message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns GenerationInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.GenerationInfo;

        /**
         * Verifies a GenerationInfo message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a GenerationInfo message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns GenerationInfo
         */
        public static fromObject(object: { [k: string]: any }): stt.GenerationInfo;

        /**
         * Creates a plain object from a GenerationInfo message. Also converts values to other types if specified.
         * @param message GenerationInfo
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.GenerationInfo, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this GenerationInfo to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for GenerationInfo
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a Statistics. */
    interface IStatistics {

        /** Statistics totalTiles */
        totalTiles?: (number|Long|null);

        /** Statistics totalFeatures */
        totalFeatures?: (number|Long|null);

        /** Statistics totalSize */
        totalSize?: (number|Long|null);

        /** Statistics uncompressedSize */
        uncompressedSize?: (number|Long|null);

        /** Statistics compressionRatio */
        compressionRatio?: (number|null);

        /** Statistics zoomStats */
        zoomStats?: (stt.IZoomStats[]|null);
    }

    /** Represents a Statistics. */
    class Statistics implements IStatistics {

        /**
         * Constructs a new Statistics.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.IStatistics);

        /** Statistics totalTiles. */
        public totalTiles: (number|Long);

        /** Statistics totalFeatures. */
        public totalFeatures: (number|Long);

        /** Statistics totalSize. */
        public totalSize: (number|Long);

        /** Statistics uncompressedSize. */
        public uncompressedSize: (number|Long);

        /** Statistics compressionRatio. */
        public compressionRatio: number;

        /** Statistics zoomStats. */
        public zoomStats: stt.IZoomStats[];

        /**
         * Creates a new Statistics instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Statistics instance
         */
        public static create(properties?: stt.IStatistics): stt.Statistics;

        /**
         * Encodes the specified Statistics message. Does not implicitly {@link stt.Statistics.verify|verify} messages.
         * @param message Statistics message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.IStatistics, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Statistics message, length delimited. Does not implicitly {@link stt.Statistics.verify|verify} messages.
         * @param message Statistics message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.IStatistics, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Statistics message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns Statistics
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.Statistics;

        /**
         * Decodes a Statistics message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns Statistics
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.Statistics;

        /**
         * Verifies a Statistics message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Statistics message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Statistics
         */
        public static fromObject(object: { [k: string]: any }): stt.Statistics;

        /**
         * Creates a plain object from a Statistics message. Also converts values to other types if specified.
         * @param message Statistics
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.Statistics, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Statistics to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for Statistics
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a ZoomStats. */
    interface IZoomStats {

        /** ZoomStats zoom */
        zoom?: (number|null);

        /** ZoomStats tileCount */
        tileCount?: (number|Long|null);

        /** ZoomStats featureCount */
        featureCount?: (number|Long|null);

        /** ZoomStats totalSize */
        totalSize?: (number|Long|null);

        /** ZoomStats avgTileSize */
        avgTileSize?: (number|null);

        /** ZoomStats avgFeaturesPerTile */
        avgFeaturesPerTile?: (number|null);
    }

    /** Represents a ZoomStats. */
    class ZoomStats implements IZoomStats {

        /**
         * Constructs a new ZoomStats.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.IZoomStats);

        /** ZoomStats zoom. */
        public zoom: number;

        /** ZoomStats tileCount. */
        public tileCount: (number|Long);

        /** ZoomStats featureCount. */
        public featureCount: (number|Long);

        /** ZoomStats totalSize. */
        public totalSize: (number|Long);

        /** ZoomStats avgTileSize. */
        public avgTileSize: number;

        /** ZoomStats avgFeaturesPerTile. */
        public avgFeaturesPerTile: number;

        /**
         * Creates a new ZoomStats instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ZoomStats instance
         */
        public static create(properties?: stt.IZoomStats): stt.ZoomStats;

        /**
         * Encodes the specified ZoomStats message. Does not implicitly {@link stt.ZoomStats.verify|verify} messages.
         * @param message ZoomStats message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.IZoomStats, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ZoomStats message, length delimited. Does not implicitly {@link stt.ZoomStats.verify|verify} messages.
         * @param message ZoomStats message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.IZoomStats, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ZoomStats message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns ZoomStats
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.ZoomStats;

        /**
         * Decodes a ZoomStats message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns ZoomStats
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.ZoomStats;

        /**
         * Verifies a ZoomStats message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ZoomStats message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ZoomStats
         */
        public static fromObject(object: { [k: string]: any }): stt.ZoomStats;

        /**
         * Creates a plain object from a ZoomStats message. Also converts values to other types if specified.
         * @param message ZoomStats
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.ZoomStats, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ZoomStats to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for ZoomStats
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a Tile. */
    interface ITile {

        /** Tile version */
        version?: (number|null);

        /** Tile timeStart */
        timeStart?: (number|Long|null);

        /** Tile timeEnd */
        timeEnd?: (number|Long|null);

        /** Tile layers */
        layers?: (stt.ILayer[]|null);
    }

    /** Represents a Tile. */
    class Tile implements ITile {

        /**
         * Constructs a new Tile.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.ITile);

        /** Tile version. */
        public version: number;

        /** Tile timeStart. */
        public timeStart: (number|Long);

        /** Tile timeEnd. */
        public timeEnd: (number|Long);

        /** Tile layers. */
        public layers: stt.ILayer[];

        /**
         * Creates a new Tile instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Tile instance
         */
        public static create(properties?: stt.ITile): stt.Tile;

        /**
         * Encodes the specified Tile message. Does not implicitly {@link stt.Tile.verify|verify} messages.
         * @param message Tile message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.ITile, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Tile message, length delimited. Does not implicitly {@link stt.Tile.verify|verify} messages.
         * @param message Tile message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.ITile, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Tile message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns Tile
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.Tile;

        /**
         * Decodes a Tile message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns Tile
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.Tile;

        /**
         * Verifies a Tile message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Tile message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Tile
         */
        public static fromObject(object: { [k: string]: any }): stt.Tile;

        /**
         * Creates a plain object from a Tile message. Also converts values to other types if specified.
         * @param message Tile
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.Tile, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Tile to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for Tile
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a Layer. */
    interface ILayer {

        /** Layer name */
        name?: (string|null);

        /** Layer extent */
        extent?: (number|null);

        /** Layer columnar */
        columnar?: (stt.IColumnarFeatures|null);
    }

    /** Represents a Layer. */
    class Layer implements ILayer {

        /**
         * Constructs a new Layer.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.ILayer);

        /** Layer name. */
        public name: string;

        /** Layer extent. */
        public extent: number;

        /** Layer columnar. */
        public columnar?: (stt.IColumnarFeatures|null);

        /**
         * Creates a new Layer instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Layer instance
         */
        public static create(properties?: stt.ILayer): stt.Layer;

        /**
         * Encodes the specified Layer message. Does not implicitly {@link stt.Layer.verify|verify} messages.
         * @param message Layer message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.ILayer, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Layer message, length delimited. Does not implicitly {@link stt.Layer.verify|verify} messages.
         * @param message Layer message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.ILayer, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Layer message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns Layer
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.Layer;

        /**
         * Decodes a Layer message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns Layer
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.Layer;

        /**
         * Verifies a Layer message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Layer message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Layer
         */
        public static fromObject(object: { [k: string]: any }): stt.Layer;

        /**
         * Creates a plain object from a Layer message. Also converts values to other types if specified.
         * @param message Layer
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.Layer, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Layer to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for Layer
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a Feature. */
    interface IFeature {
    }

    /** Represents a Feature. */
    class Feature implements IFeature {

        /**
         * Constructs a new Feature.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.IFeature);

        /**
         * Creates a new Feature instance using the specified properties.
         * @param [properties] Properties to set
         * @returns Feature instance
         */
        public static create(properties?: stt.IFeature): stt.Feature;

        /**
         * Encodes the specified Feature message. Does not implicitly {@link stt.Feature.verify|verify} messages.
         * @param message Feature message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.IFeature, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified Feature message, length delimited. Does not implicitly {@link stt.Feature.verify|verify} messages.
         * @param message Feature message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.IFeature, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a Feature message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns Feature
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.Feature;

        /**
         * Decodes a Feature message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns Feature
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.Feature;

        /**
         * Verifies a Feature message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a Feature message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns Feature
         */
        public static fromObject(object: { [k: string]: any }): stt.Feature;

        /**
         * Creates a plain object from a Feature message. Also converts values to other types if specified.
         * @param message Feature
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.Feature, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this Feature to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for Feature
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    namespace Feature {

        /** GeomType enum. */
        enum GeomType {
            POINT = 0,
            LINESTRING = 1,
            POLYGON = 2
        }
    }

    /** Properties of a ColumnarFeatures. */
    interface IColumnarFeatures {

        /** ColumnarFeatures featureCount */
        featureCount?: (number|null);

        /** ColumnarFeatures geometryType */
        geometryType?: (stt.Feature.GeomType|null);

        /** ColumnarFeatures featureIds */
        featureIds?: ((number|Long)[]|null);

        /** ColumnarFeatures geometry */
        geometry?: (number[]|null);

        /** ColumnarFeatures geometryOffsets */
        geometryOffsets?: (number[]|null);

        /** ColumnarFeatures startTimes */
        startTimes?: ((number|Long)[]|null);

        /** ColumnarFeatures endTimes */
        endTimes?: ((number|Long)[]|null);

        /** ColumnarFeatures numericProperties */
        numericProperties?: (stt.INumericColumn[]|null);

        /** ColumnarFeatures categoricalProperties */
        categoricalProperties?: (stt.ICategoricalColumn[]|null);

        /** ColumnarFeatures ringOffsets */
        ringOffsets?: (number[]|null);

        /** ColumnarFeatures ringOffsetsOffsets */
        ringOffsetsOffsets?: (number[]|null);

        /** ColumnarFeatures altitudes */
        altitudes?: (number[]|null);

        /** ColumnarFeatures vertexTimestamps */
        vertexTimestamps?: ((number|Long)[]|null);
    }

    /** Represents a ColumnarFeatures. */
    class ColumnarFeatures implements IColumnarFeatures {

        /**
         * Constructs a new ColumnarFeatures.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.IColumnarFeatures);

        /** ColumnarFeatures featureCount. */
        public featureCount: number;

        /** ColumnarFeatures geometryType. */
        public geometryType: stt.Feature.GeomType;

        /** ColumnarFeatures featureIds. */
        public featureIds: (number|Long)[];

        /** ColumnarFeatures geometry. */
        public geometry: number[];

        /** ColumnarFeatures geometryOffsets. */
        public geometryOffsets: number[];

        /** ColumnarFeatures startTimes. */
        public startTimes: (number|Long)[];

        /** ColumnarFeatures endTimes. */
        public endTimes: (number|Long)[];

        /** ColumnarFeatures numericProperties. */
        public numericProperties: stt.INumericColumn[];

        /** ColumnarFeatures categoricalProperties. */
        public categoricalProperties: stt.ICategoricalColumn[];

        /** ColumnarFeatures ringOffsets. */
        public ringOffsets: number[];

        /** ColumnarFeatures ringOffsetsOffsets. */
        public ringOffsetsOffsets: number[];

        /** ColumnarFeatures altitudes. */
        public altitudes: number[];

        /** ColumnarFeatures vertexTimestamps. */
        public vertexTimestamps: (number|Long)[];

        /**
         * Creates a new ColumnarFeatures instance using the specified properties.
         * @param [properties] Properties to set
         * @returns ColumnarFeatures instance
         */
        public static create(properties?: stt.IColumnarFeatures): stt.ColumnarFeatures;

        /**
         * Encodes the specified ColumnarFeatures message. Does not implicitly {@link stt.ColumnarFeatures.verify|verify} messages.
         * @param message ColumnarFeatures message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.IColumnarFeatures, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified ColumnarFeatures message, length delimited. Does not implicitly {@link stt.ColumnarFeatures.verify|verify} messages.
         * @param message ColumnarFeatures message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.IColumnarFeatures, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a ColumnarFeatures message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns ColumnarFeatures
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.ColumnarFeatures;

        /**
         * Decodes a ColumnarFeatures message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns ColumnarFeatures
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.ColumnarFeatures;

        /**
         * Verifies a ColumnarFeatures message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a ColumnarFeatures message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns ColumnarFeatures
         */
        public static fromObject(object: { [k: string]: any }): stt.ColumnarFeatures;

        /**
         * Creates a plain object from a ColumnarFeatures message. Also converts values to other types if specified.
         * @param message ColumnarFeatures
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.ColumnarFeatures, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this ColumnarFeatures to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for ColumnarFeatures
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a NumericColumn. */
    interface INumericColumn {

        /** NumericColumn name */
        name?: (string|null);

        /** NumericColumn values */
        values?: (number[]|null);

        /** NumericColumn valuesF64 */
        valuesF64?: (number[]|null);
    }

    /** Represents a NumericColumn. */
    class NumericColumn implements INumericColumn {

        /**
         * Constructs a new NumericColumn.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.INumericColumn);

        /** NumericColumn name. */
        public name: string;

        /** NumericColumn values. */
        public values: number[];

        /** NumericColumn valuesF64. */
        public valuesF64: number[];

        /**
         * Creates a new NumericColumn instance using the specified properties.
         * @param [properties] Properties to set
         * @returns NumericColumn instance
         */
        public static create(properties?: stt.INumericColumn): stt.NumericColumn;

        /**
         * Encodes the specified NumericColumn message. Does not implicitly {@link stt.NumericColumn.verify|verify} messages.
         * @param message NumericColumn message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.INumericColumn, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified NumericColumn message, length delimited. Does not implicitly {@link stt.NumericColumn.verify|verify} messages.
         * @param message NumericColumn message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.INumericColumn, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a NumericColumn message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns NumericColumn
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.NumericColumn;

        /**
         * Decodes a NumericColumn message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns NumericColumn
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.NumericColumn;

        /**
         * Verifies a NumericColumn message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a NumericColumn message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns NumericColumn
         */
        public static fromObject(object: { [k: string]: any }): stt.NumericColumn;

        /**
         * Creates a plain object from a NumericColumn message. Also converts values to other types if specified.
         * @param message NumericColumn
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.NumericColumn, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this NumericColumn to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for NumericColumn
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }

    /** Properties of a CategoricalColumn. */
    interface ICategoricalColumn {

        /** CategoricalColumn name */
        name?: (string|null);

        /** CategoricalColumn categories */
        categories?: (string[]|null);

        /** CategoricalColumn indices */
        indices?: (Uint8Array|null);
    }

    /** Represents a CategoricalColumn. */
    class CategoricalColumn implements ICategoricalColumn {

        /**
         * Constructs a new CategoricalColumn.
         * @param [properties] Properties to set
         */
        constructor(properties?: stt.ICategoricalColumn);

        /** CategoricalColumn name. */
        public name: string;

        /** CategoricalColumn categories. */
        public categories: string[];

        /** CategoricalColumn indices. */
        public indices: Uint8Array;

        /**
         * Creates a new CategoricalColumn instance using the specified properties.
         * @param [properties] Properties to set
         * @returns CategoricalColumn instance
         */
        public static create(properties?: stt.ICategoricalColumn): stt.CategoricalColumn;

        /**
         * Encodes the specified CategoricalColumn message. Does not implicitly {@link stt.CategoricalColumn.verify|verify} messages.
         * @param message CategoricalColumn message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encode(message: stt.ICategoricalColumn, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Encodes the specified CategoricalColumn message, length delimited. Does not implicitly {@link stt.CategoricalColumn.verify|verify} messages.
         * @param message CategoricalColumn message or plain object to encode
         * @param [writer] Writer to encode to
         * @returns Writer
         */
        public static encodeDelimited(message: stt.ICategoricalColumn, writer?: $protobuf.Writer): $protobuf.Writer;

        /**
         * Decodes a CategoricalColumn message from the specified reader or buffer.
         * @param reader Reader or buffer to decode from
         * @param [length] Message length if known beforehand
         * @returns CategoricalColumn
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): stt.CategoricalColumn;

        /**
         * Decodes a CategoricalColumn message from the specified reader or buffer, length delimited.
         * @param reader Reader or buffer to decode from
         * @returns CategoricalColumn
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): stt.CategoricalColumn;

        /**
         * Verifies a CategoricalColumn message.
         * @param message Plain object to verify
         * @returns `null` if valid, otherwise the reason why it is not
         */
        public static verify(message: { [k: string]: any }): (string|null);

        /**
         * Creates a CategoricalColumn message from a plain object. Also converts values to their respective internal types.
         * @param object Plain object
         * @returns CategoricalColumn
         */
        public static fromObject(object: { [k: string]: any }): stt.CategoricalColumn;

        /**
         * Creates a plain object from a CategoricalColumn message. Also converts values to other types if specified.
         * @param message CategoricalColumn
         * @param [options] Conversion options
         * @returns Plain object
         */
        public static toObject(message: stt.CategoricalColumn, options?: $protobuf.IConversionOptions): { [k: string]: any };

        /**
         * Converts this CategoricalColumn to JSON.
         * @returns JSON object
         */
        public toJSON(): { [k: string]: any };

        /**
         * Gets the default type url for CategoricalColumn
         * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
         * @returns The default type url
         */
        public static getTypeUrl(typeUrlPrefix?: string): string;
    }
}
