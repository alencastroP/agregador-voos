CREATE TABLE "provider_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"search_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"offers_count" integer NOT NULL,
	"discarded_count" integer NOT NULL,
	"attempts" smallint NOT NULL,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "searches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin" char(3) NOT NULL,
	"destination" char(3) NOT NULL,
	"travel_date" date NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"cache_hit" boolean NOT NULL,
	"partial" boolean NOT NULL,
	"latency_ms" integer NOT NULL,
	"results_count" integer NOT NULL,
	"strategy" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selected_offers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"search_id" uuid NOT NULL,
	"flight_key" text NOT NULL,
	"airline" text NOT NULL,
	"departure_at" timestamp NOT NULL,
	"chosen_provider" text NOT NULL,
	"chosen_price_cents" integer NOT NULL,
	"cheapest_price_cents" integer NOT NULL,
	"cheapest_provider" text NOT NULL,
	"incentive_cents" integer NOT NULL,
	"incentive_gain_vs_cheapest_cents" integer NOT NULL,
	"customer_delta_cents" integer NOT NULL,
	"alternatives_count" smallint NOT NULL,
	"strategy" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selected_offers" ADD CONSTRAINT "selected_offers_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_calls_search_idx" ON "provider_calls" USING btree ("search_id");--> statement-breakpoint
CREATE INDEX "provider_calls_provider_idx" ON "provider_calls" USING btree ("provider","status");--> statement-breakpoint
CREATE INDEX "searches_requested_at_idx" ON "searches" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "searches_route_idx" ON "searches" USING btree ("origin","destination");--> statement-breakpoint
CREATE INDEX "selected_offers_search_idx" ON "selected_offers" USING btree ("search_id");--> statement-breakpoint
CREATE INDEX "selected_offers_provider_idx" ON "selected_offers" USING btree ("chosen_provider");