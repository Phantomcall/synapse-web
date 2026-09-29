"use client";
import React, { useId } from "react";
import { BG3, BORDER, DIM, MONO } from "@/lib/constants";

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  id?: string;
  error?: string;
}

export function Field({ label, value, onChange, placeholder, type = "text", id: customId, error }: FieldProps) {
  const generatedId = useId();
  const inputId = customId || generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div>
      <label
        htmlFor={inputId}
        style={{
          display: "block",
          fontSize: 9,
          color: DIM,
          fontFamily: MONO,
          marginBottom: 4,
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </label>
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        style={{
          width: "100%",
          background: BG3,
          border: `1px solid ${error ? "#e06c75" : BORDER}`,
          color: "#eee",
          fontFamily: MONO,
          fontSize: 11,
          padding: "7px 10px",
          outline: "none",
          transition: "border-color 0.15s, box-shadow 0.15s",
          boxSizing: "border-box",
        }}
        onFocus={(e) => {
          e.target.style.borderColor = "rgba(245,166,35,0.75)";
          e.target.style.boxShadow = "0 0 0 1px rgba(245,166,35,0.4)";
        }}
        onBlur={(e) => {
          e.target.style.borderColor = error ? "#e06c75" : BORDER;
          e.target.style.boxShadow = "none";
        }}
      />
      {error && (
        <div
          id={errorId}
          role="alert"
          style={{
            fontSize: 9,
            color: "#e06c75",
            fontFamily: MONO,
            marginTop: 4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
