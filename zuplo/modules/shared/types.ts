// Shared TypeScript interfaces used across all MCP server modules

export interface ProductResult {
  id: string;
  title: string;
  price: number;
  currency: string;
  url: string;
  imageUrl?: string;
  description?: string;
  supplier?: string;
}

export interface EventResult {
  id: string;
  name: string;
  date: string;
  venue: string;
  city?: string;
  url: string;
  imageUrl?: string;
  priceRange?: string;
}

export interface FlightResult {
  origin: string;
  destination: string;
  price: number;
  currency: string;
  departureDate: string;
  returnDate?: string;
  airline?: string;
  url: string;
}

export interface HotelResult {
  id: string;
  name: string;
  city: string;
  stars?: number;
  pricePerNight: number;
  currency: string;
  url: string;
  imageUrl?: string;
}

export interface ExperienceResult {
  id: string;
  title: string;
  destination: string;
  price: number;
  currency: string;
  duration?: string;
  url: string;
  imageUrl?: string;
}

export interface ToolResponse<T> {
  results: T[];
  total?: number;
  source: string;
}

export function errorResponse(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonResponse<T>(data: ToolResponse<T>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
