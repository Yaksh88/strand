import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { getToken, setToken } from "../api/client";

export function Settings() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token, setValue] = useState(getToken);

  const save = (event: FormEvent) => {
    event.preventDefault();
    setToken(token.trim());
    void queryClient.invalidateQueries();
    navigate("/");
  };

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>Settings</h1>
          <p className="page__lede">The dashboard talks to the Strand server's API.</p>
        </div>
      </header>

      {params.get("reason") === "unauthorized" ? (
        <div className="notice notice--madder" role="alert">
          <p className="notice__title">The server rejected this token</p>
          <p className="notice__body">
            Enter the value of STRAND_API_TOKEN from the server's environment.
          </p>
        </div>
      ) : null}

      <section className="section">
        <h2>API token</h2>
        <form onSubmit={save} className="row">
          <label className="field" style={{ flex: "1 1 320px", maxWidth: 480 }}>
            Token
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Leave empty if the server has no token"
            />
          </label>
          <button type="submit" className="button">
            Save token
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              setToken("");
              setValue("");
              void queryClient.clear();
            }}
          >
            Remove token
          </button>
        </form>
        <p className="muted" style={{ maxWidth: "70ch" }}>
          The token is kept in this browser's local storage and sent only to the server that serves
          this page.
        </p>
      </section>
    </div>
  );
}
