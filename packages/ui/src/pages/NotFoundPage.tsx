import { Link } from "react-router-dom";
import { useDocumentTitle } from "../util";

export function NotFoundPage({ what = "page" }: { what?: string }) {
  useDocumentTitle("Not found");
  return (
    <div className="pf-container pf-page">
      <div className="pf-404">
        <div className="pf-404__code" aria-hidden="true">
          404
        </div>
        <h1>Game over — {what} not found</h1>
        <p className="pf-muted">The {what} you're looking for doesn't exist, was removed, or isn't published yet.</p>
        <div className="pf-hero__cta">
          <Link to="/" className="pf-btn pf-btn--primary">
            Back to the arcade
          </Link>
        </div>
      </div>
    </div>
  );
}
