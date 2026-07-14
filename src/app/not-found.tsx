"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function NotFound() {
  const router = useRouter();
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    if (window.history.length > 1) {
      setCanGoBack(true);
    }
  }, []);

  const handleGoBack = () => {
    if (canGoBack) {
      router.back(); 
    } else {
      router.push("/");
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        backgroundColor: "#f5f5f5",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "4rem", marginBottom: "1rem" }}>404</h1>
      <p style={{ marginBottom: "2rem" }}>
        Sorry, the page you are looking for does not exist.
      </p>
      <button
        onClick={handleGoBack}
        style={{
          padding: "0.5rem 1rem",
          fontSize: "1rem",
          borderRadius: "5px",
          border: "none",
          backgroundColor: "#0070f3",
          color: "#fff",
          cursor: "pointer",
        }}
      >
        Back
      </button>
    </div>
  );
}