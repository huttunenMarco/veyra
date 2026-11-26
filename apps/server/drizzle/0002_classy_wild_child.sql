CREATE TABLE "sensor_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sensor_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"source_frame_id" uuid,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sensors" ADD COLUMN "use_examples" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sensor_examples" ADD CONSTRAINT "sensor_examples_sensor_id_sensors_id_fk" FOREIGN KEY ("sensor_id") REFERENCES "public"."sensors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensor_examples" ADD CONSTRAINT "sensor_examples_source_frame_id_camera_frames_id_fk" FOREIGN KEY ("source_frame_id") REFERENCES "public"."camera_frames"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sensor_examples_sensor_idx" ON "sensor_examples" USING btree ("sensor_id");