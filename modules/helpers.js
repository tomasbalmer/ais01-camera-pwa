import { AI_DECIMAL_SCALE } from './constants.js';

// Search for a byte sequence in an array, return index or -1
export function findMarker(data, start, marker) {
    const end = data.length - marker.length;
    for (let i = start; i <= end; i++) {
        let match = true;
        for (let j = 0; j < marker.length; j++) {
            if (data[i + j] !== marker[j]) { match = false; break; }
        }
        if (match) return i;
    }
    return -1;
}

// Manual little-endian u32 read from byte array
export function readU32LE(bytes, offset) {
    return bytes[offset]
        | (bytes[offset + 1] << 8)
        | (bytes[offset + 2] << 16)
        | (bytes[offset + 3] << 24);
}

// Convert AI result to numeric reading
export function aiReading(result) {
    if (!result) return null;
    return result.integer + result.decimal / AI_DECIMAL_SCALE;
}
