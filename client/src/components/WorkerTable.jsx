import { useState } from "react";
import { WORK_AREA_SWATCH } from "../utils/workAreas.js";
import { FortnightCell, FortnightModal } from "./FortnightAvailability.jsx";

export default function WorkerTable({ workers, onEdit, onDelete }) {
  const [openWorker, setOpenWorker] = useState(null);

  if (workers.length === 0) {
    return <p className="empty-state">No workers yet. Add your first one above.</p>;
  }

  return (
    <div className="table-scroll">
    <table className="worker-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Location</th>
          <th>Work area</th>
          <th>Gender</th>
          <th>Phone</th>
          <th>Availability</th>
          <th>Skill</th>
          <th>Priority</th>
          <th>Active jobs</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {workers.map((w) => (
          <tr key={w._id}>
            <td>{w.name}</td>
            <td>{w.email}</td>
            <td>{w.location}</td>
            <td>
              {w.workArea ? (
                <span className="area-tag">
                  <span className="area-dot" style={{ background: WORK_AREA_SWATCH[w.workArea] }} />
                  {w.workArea}
                </span>
              ) : (
                <span className="muted small">-</span>
              )}
            </td>
            <td>{w.gender}</td>
            <td>{w.phone || "-"}</td>
            <td>
              <FortnightCell worker={w} onOpen={setOpenWorker} />
            </td>
            <td>{"★".repeat(w.skillLevel)}{"☆".repeat(5 - w.skillLevel)}</td>
            <td>
              <span className={`pill pill-priority-${w.priority.toLowerCase()}`}>{w.priority}</span>
            </td>
            <td>{w.activeJobCount ?? 0}</td>
            <td className="row-actions">
              <button className="btn btn-small" onClick={() => onEdit(w)}>
                Edit
              </button>
              <button className="btn btn-small btn-danger" onClick={() => onDelete(w)}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    <FortnightModal worker={openWorker} onClose={() => setOpenWorker(null)} />
    </div>
  );
}
