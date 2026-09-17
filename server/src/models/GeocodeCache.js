import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * A tiny persistent cache of address -> {lat, lng}, completely separate
 * from Worker/Job documents. This is what lets the app (and the seed
 * script) skip hitting Nominatim/LocationIQ entirely for an address it has
 * already successfully resolved once, even if the worker/job record that
 * originally asked for it gets deleted and recreated later (exactly what
 * `npm run seed` does every time it runs, since it wipes and rebuilds the
 * same mock addresses).
 */
const GeocodeCacheSchema = new Schema(
  {
    // Normalized (trimmed, lowercased) address text - the actual cache key.
    key: { type: String, required: true, unique: true, index: true },
    // Original address text, kept only for readability when inspecting the collection.
    address: { type: String, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  { timestamps: true }
);

export default mongoose.model("GeocodeCache", GeocodeCacheSchema);
