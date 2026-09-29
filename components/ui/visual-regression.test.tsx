import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Badge } from "./Badge";
import { ActionButton } from "./ActionButton";
import { Panel } from "./Panel";
import { Field } from "./Field";

describe("Visual Component Snapshot Regression Suite", () => {
  it("matches visual snapshot for Badge across all statuses", () => {
    const statuses = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;
    const { container } = render(
      <div>
        {statuses.map((s) => (
          <Badge key={s} status={s} />
        ))}
      </div>
    );
    expect(container).toMatchSnapshot();
  });

  it("matches visual snapshot for ActionButton variants", () => {
    const { container } = render(
      <div>
        <ActionButton label="NORMAL" color="#f5a623" onClick={() => {}} />
        <ActionButton label="DISABLED" color="#66bb6a" onClick={() => {}} disabled />
        <ActionButton label="BUSY" color="#4fc3f7" onClick={() => {}} busy />
      </div>
    );
    expect(container).toMatchSnapshot();
  });

  it("matches visual snapshot for Panel container", () => {
    const { container } = render(
      <Panel title="TEST PANEL">
        <div>Panel content body</div>
      </Panel>
    );
    expect(container).toMatchSnapshot();
  });

  it("matches visual snapshot for Field with error state", () => {
    const { container } = render(
      <Field label="Address" value="GBZ..." onChange={() => {}} error="Invalid address" />
    );
    expect(container).toMatchSnapshot();
  });
});
