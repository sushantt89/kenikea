import { useEffect, useRef, useState } from "react";
import WorkerForm from "../components/WorkerForm.jsx";
import WorkerTable from "../components/WorkerTable.jsx";
import { getWorkers, createWorker, updateWorker, deleteWorker } from "../api.js";

export default function Workers() {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // worker being edited, or null for "add"
  const [showForm, setShowForm] = useState(false);

  // Same fix as Jobs.jsx's loadAll() - see the comment there. Without
  // hasLoadedOnce, editing/adding/deleting a worker while scrolled down
  // the list would flip `loading` back to true, unmount the whole
  // WorkerTable to show "Loading workers..." again, then remount it -
  // which resets scroll to the top of the page every time.
  const hasLoadedOnce = useRef(false);

  async function load() {
    if (!hasLoadedOnce.current) setLoading(true);
    setError("");
    try {
      setWorkers(await getWorkers());
      hasLoadedOnce.current = true;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSubmit(data) {
    if (editing) {
      await updateWorker(editing._id, data);
    } else {
      await createWorker(data);
    }
    setShowForm(false);
    setEditing(null);
    await load();
  }

  async function handleDelete(worker) {
    if (!window.confirm(`Delete ${worker.name}? Any jobs assigned to them will become unassigned.`)) {
      return;
    }
    try {
      await deleteWorker(worker._id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Workers</h1>
        <button
          className="btn btn-primary"
          onClick={() => {
            setEditing(null);
            setShowForm((s) => !s);
          }}
        >
          {showForm && !editing ? "Close" : "+ Add worker"}
        </button>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {(showForm || editing) && (
        <div className="card">
          <h2>{editing ? `Edit ${editing.name}` : "New worker"}</h2>
          <WorkerForm
            initial={editing}
            submitLabel={editing ? "Save changes" : "Add worker"}
            onSubmit={handleSubmit}
            onCancel={() => {
              setShowForm(false);
              setEditing(null);
            }}
          />
        </div>
      )}

      {loading ? (
        <p>Loading workers...</p>
      ) : (
        <WorkerTable
          workers={workers}
          onEdit={(w) => {
            setEditing(w);
            setShowForm(true);
          }}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
