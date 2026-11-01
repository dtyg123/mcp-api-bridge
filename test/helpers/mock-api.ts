import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

export type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  body: unknown;
};

export type MockApi = {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

const pets = [
  { id: "1", name: "Rex", status: "available" },
  { id: "2", name: "Milo", status: "sold" },
  { id: "3", name: "Luna", status: "available" },
];

export async function startMockApi(): Promise<MockApi> {
  const requests: RecordedRequest[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    requests.push({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body });
    next();
  });

  app.get("/pets", (req, res) => {
    const limit = Number(req.query.limit ?? pets.length);
    res.json({
      items: pets.slice(0, Number.isFinite(limit) ? limit : pets.length),
      tags: req.query.tags ?? [],
      status: req.query.status ?? null,
    });
  });

  app.post("/pets", (req, res) => {
    res.status(201).json({ created: req.body });
  });

  app.get("/pets/:petId", (req, res) => {
    const pet = pets.find((item) => item.id === req.params.petId);
    if (!pet) {
      res.status(404).json({ message: "not found" });
      return;
    }
    res.json(pet);
  });

  app.get("/secure", (req, res) => {
    if (req.headers["x-api-key"] !== "s3cret") {
      res.status(401).json({ message: "unauthorized" });
      return;
    }
    res.json({ ok: true, key: req.headers["x-api-key"] });
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
