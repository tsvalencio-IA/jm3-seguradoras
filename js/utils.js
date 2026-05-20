(function () {
  "use strict";

  const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const DATE_TIME = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

  function $(id) {
    return document.getElementById(id);
  }

  function $all(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[m]));
  }

  function money(value) {
    const n = Number(String(value || 0).replace(/\./g, "").replace(",", ".")) || 0;
    return BRL.format(n);
  }

  function parseMoney(value) {
    if (typeof value === "number") return value;
    return Number(String(value || "0").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".")) || 0;
  }

  function dateTime(value) {
    if (!value) return "-";
    const d = value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
    return Number.isNaN(d.getTime()) ? "-" : DATE_TIME.format(d);
  }

  function todayInput() {
    return new Date().toISOString().slice(0, 10);
  }

  function slug(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/[^A-Z0-9]+/g, "")
      .trim();
  }

  function plateKey(value) {
    return slug(value || "").slice(0, 7);
  }

  function uidSafe(value) {
    return String(value || "").toLowerCase().replace(/[.#$\[\]/]/g, "_");
  }

  function coords(lat, lng) {
    const la = Number(String(lat || "").replace(",", "."));
    const ln = Number(String(lng || "").replace(",", "."));
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
    return { lat: la, lng: ln };
  }

  function pointFrom(value) {
    if (!value) return null;
    if (value.coords) return pointFrom(value.coords);
    if (value.location) return pointFrom(value.location);
    if (Array.isArray(value) && value.length >= 2) return coords(value[0], value[1]);
    return coords(value.lat, value.lng);
  }

  function isPoint(value) {
    return !!pointFrom(value);
  }

  function roundPoint(value, precision) {
    const p = pointFrom(value);
    if (!p) return null;
    const pow = Math.pow(10, precision == null ? 5 : precision);
    return {
      lat: Math.round(p.lat * pow) / pow,
      lng: Math.round(p.lng * pow) / pow
    };
  }

  function haversineKm(a, b) {
    const pa = pointFrom(a);
    const pb = pointFrom(b);
    if (!pa || !pb) return 0;
    const R = 6371;
    const dLat = (pb.lat - pa.lat) * Math.PI / 180;
    const dLng = (pb.lng - pa.lng) * Math.PI / 180;
    const la1 = pa.lat * Math.PI / 180;
    const la2 = pb.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function normalizeWaypoint(row, index) {
    const point = pointFrom(row && (row.coords || row.point || row));
    if (!point) return null;
    return {
      label: row && row.label || "Parada " + (index + 1),
      point
    };
  }

  function callRoutePoints(call, vehicle) {
    const points = [];
    const vehiclePoint = pointFrom(vehicle && vehicle.location);
    const originPoint = pointFrom(call && (call.origem || call.origin));
    const destinationPoint = pointFrom(call && (call.destino || call.destination));
    if (vehiclePoint) points.push({ label: vehicle && (vehicle.placa || vehicle.apelido) || "Veículo", point: vehiclePoint, kind: "vehicle" });
    if (originPoint) points.push({ label: call && (call.originLabel || call.origem && call.origem.label) || "Origem", point: originPoint, kind: "origin" });
    (call && Array.isArray(call.routeWaypoints) ? call.routeWaypoints : []).forEach((row, index) => {
      const wp = normalizeWaypoint(row, index);
      if (wp) points.push({ label: wp.label, point: wp.point, kind: "waypoint" });
    });
    if (destinationPoint) points.push({ label: call && (call.destLabel || call.destino && call.destino.label) || "Destino", point: destinationPoint, kind: "destination" });
    return points;
  }

  function routeKm(input, vehicle) {
    const points = Array.isArray(input) ? input : callRoutePoints(input, vehicle);
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1].point || points[i - 1], points[i].point || points[i]);
    return total;
  }

  function geoJsonToLatLngs(geometry) {
    if (!geometry || geometry.type !== "LineString" || !Array.isArray(geometry.coordinates)) return [];
    return geometry.coordinates
      .map((pair) => Array.isArray(pair) && pair.length >= 2 ? [Number(pair[1]), Number(pair[0])] : null)
      .filter((pair) => pair && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
  }

  function geometryKm(geometry) {
    const latlngs = geoJsonToLatLngs(geometry);
    let total = 0;
    for (let i = 1; i < latlngs.length; i += 1) {
      total += haversineKm({ lat: latlngs[i - 1][0], lng: latlngs[i - 1][1] }, { lat: latlngs[i][0], lng: latlngs[i][1] });
    }
    return total;
  }

  function mapsRouteUrl(input, vehicle) {
    const points = Array.isArray(input) ? input : callRoutePoints(input, vehicle);
    const clean = points.map((p) => pointFrom(p.point || p)).filter(Boolean);
    if (clean.length < 2) return "";
    const q = new URLSearchParams({ api: "1", travelmode: "driving" });
    q.set("origin", clean[0].lat + "," + clean[0].lng);
    q.set("destination", clean[clean.length - 1].lat + "," + clean[clean.length - 1].lng);
    if (clean.length > 2) q.set("waypoints", clean.slice(1, -1).map((p) => p.lat + "," + p.lng).join("|"));
    return "https://www.google.com/maps/dir/?" + q.toString();
  }

  function normalizeUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^(maps\.app\.goo\.gl|goo\.gl\/maps|waze\.com|www\.google\.)/i.test(raw)) return "https://" + raw;
    return "";
  }

  function toast(message, type) {
    const box = $("toast");
    if (!box) return alert(message);
    box.textContent = message;
    box.className = "toast show " + (type || "info");
    clearTimeout(window.__jmToastTimer);
    window.__jmToastTimer = setTimeout(() => { box.className = "toast"; }, 3500);
  }

  function statusClass(status) {
    const key = String(status || "").toLowerCase();
    if (key.includes("final")) return "ok";
    if (key.includes("cancel")) return "danger";
    if (key.includes("atendimento") || key.includes("rota")) return "info";
    if (key.includes("despach")) return "warn";
    return "muted";
  }

  window.JM = window.JM || {};
  window.JM.utils = {
    $, $all, esc, money, parseMoney, dateTime, todayInput, slug, plateKey,
    uidSafe, coords, pointFrom, isPoint, roundPoint, haversineKm, callRoutePoints,
    routeKm, geoJsonToLatLngs, geometryKm, mapsRouteUrl, normalizeUrl, toast, statusClass
  };
}());
