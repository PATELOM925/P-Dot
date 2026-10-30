"use client";

import { mapsSearchUrl } from "@/lib/maps-url";
import type { ChecklistBlock, PlacesBlock, RichBlock, StepsBlock, TableBlock } from "@/lib/rich-blocks";
import { CiteChip } from "../markdown/cite";

// Cards for ```pdot-*``` blocks. Every value is plain text. The only link is the
// Maps search link that P-Dot builds from the place name.

function Cites({ cite }: { cite?: number[] }) {
  if (!cite || cite.length === 0) return null;
  return (
    <span className="rich-cites">
      {cite.map((n) => (
        <CiteChip key={n} n={n} />
      ))}
    </span>
  );
}

function Places({ data }: { data: PlacesBlock }) {
  return (
    <section className="rich-card" aria-label={data.title ?? "Places"}>
      {data.title && <p className="rich-title">{data.title}</p>}
      <ul className="rich-places">
        {data.items.map((place, index) => {
          const url = mapsSearchUrl(place);
          const meta = [place.kind, place.area].filter(Boolean).join(" · ");
          return (
            <li key={index} className="rich-place">
              <p className="rich-place-name">
                {place.name}
                <Cites cite={place.cite} />
              </p>
              {meta && <p className="rich-meta">{meta}</p>}
              {place.note && <p>{place.note}</p>}
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  referrerPolicy="no-referrer"
                  aria-label={`Open ${place.name} in Google Maps (opens in a new tab)`}
                >
                  Open in Maps ↗
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <p className="rich-foot">Map links search by name. Check the place before you go.</p>
    </section>
  );
}

function Table({ data }: { data: TableBlock }) {
  const withCites = data.rows.some((row) => row.cite);
  return (
    <div className="md-table rich-table" role="region" aria-label={data.title ?? "Table"} tabIndex={0}>
      <table>
        {data.title && <caption>{data.title}</caption>}
        <thead>
          <tr>
            {data.columns.map((column, index) => (
              <th key={index} scope="col">
                {column}
              </th>
            ))}
            {withCites && <th scope="col">Source</th>}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.cells.map((cell, cellIndex) =>
                cell === null ? (
                  <td key={cellIndex} aria-label="No data">
                    ·
                  </td>
                ) : (
                  <td key={cellIndex} className={typeof cell === "number" ? "md-align-right rich-number" : undefined}>
                    {String(cell)}
                  </td>
                ),
              )}
              {withCites && (
                <td>
                  <Cites cite={row.cite} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Checklist({ data }: { data: ChecklistBlock }) {
  return (
    <section className="rich-card" aria-label={data.title ?? "Checklist"}>
      {data.title && <p className="rich-title">{data.title}</p>}
      <ul className="rich-checklist">
        {data.items.map((item, index) => (
          <li key={index}>
            <span aria-hidden="true">{item.done ? "☑" : "☐"}</span>
            <span className="visually-hidden">{item.done ? "Done: " : "Not done: "}</span>
            {item.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Steps({ data }: { data: StepsBlock }) {
  return (
    <section className="rich-card" aria-label={data.title ?? "Steps"}>
      {data.title && <p className="rich-title">{data.title}</p>}
      <ol className="rich-steps">
        {data.items.map((step, index) => (
          <li key={index}>
            {step.when && <p className="rich-when">{step.when}</p>}
            <p className="rich-step-title">
              {step.title}
              <Cites cite={step.cite} />
            </p>
            {step.detail && <p>{step.detail}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RichBlockView({ block }: { block: RichBlock }) {
  switch (block.kind) {
    case "places":
      return <Places data={block.data} />;
    case "table":
      return <Table data={block.data} />;
    case "checklist":
      return <Checklist data={block.data} />;
    case "steps":
      return <Steps data={block.data} />;
  }
}
