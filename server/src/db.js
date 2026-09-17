import mongoose from "mongoose";

let connected = false;

export async function connectDB() {
  if (connected) return mongoose.connection;

  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/worker_assignment";

  mongoose.connection.on("connected", () => {
    console.log(`[db] connected to MongoDB (${maskUri(uri)})`);
  });

  mongoose.connection.on("error", (err) => {
    console.error("[db] connection error:", err.message);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("[db] disconnected from MongoDB");
  });

  await mongoose.connect(uri, {
    // sensible defaults; mongoose 8 no longer needs most legacy options
    serverSelectionTimeoutMS: 8000,
  });

  connected = true;
  return mongoose.connection;
}

function maskUri(uri) {
  // hide credentials if present, e.g. mongodb+srv://user:pass@host/db -> mongodb+srv://***@host/db
  return uri.replace(/\/\/([^@/]+)@/, "//***@");
}
