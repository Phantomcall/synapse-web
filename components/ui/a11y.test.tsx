import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { ActionButton } from "./ActionButton";
import { Field } from "./Field";

describe("WCAG 2.1 AA Accessibility & Keyboard Navigation Suite", () => {
  describe("ActionButton", () => {
    it("renders with accessible button attributes and busy state", () => {
      const onClick = vi.fn();
      render(<ActionButton label="SUBMIT" color="#f5a623" onClick={onClick} busy={true} />);

      const button = screen.getByRole("button");
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.getAttribute("aria-disabled")).toBe("true");
    });
  });

  describe("Field", () => {
    it("links label with input using htmlFor and id", () => {
      render(
        <Field
          id="custom-test-field"
          label="Custom Field"
          value=""
          onChange={() => {}}
          error="Field is required"
        />
      );

      const label = screen.getByText("Custom Field");
      const input = screen.getByRole("textbox");
      expect(label.getAttribute("for")).toBe("custom-test-field");
      expect(input.id).toBe("custom-test-field");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByRole("alert").textContent).toBe("Field is required");
    });
  });

  describe("ConfirmDialog Focus Trap & Keyboard Handling", () => {
    it("handles Escape key to trigger onCancel", () => {
      const onCancel = vi.fn();
      const onConfirm = vi.fn();

      render(
        <ConfirmDialog
          title="Confirm Action"
          message="Are you sure you want to proceed?"
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("requires retype value before confirming when retypeValue is specified", () => {
      const onCancel = vi.fn();
      const onConfirm = vi.fn();

      render(
        <ConfirmDialog
          title="Dangerous Action"
          message="Retype required to continue"
          retypeValue="CONFIRM_ME"
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );

      const input = screen.getByRole("textbox");
      const confirmButton = screen.getByText("CONFIRM →");

      fireEvent.click(confirmButton);
      expect(onConfirm).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: "CONFIRM_ME" } });
      fireEvent.click(confirmButton);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});
