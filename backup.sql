--
-- PostgreSQL database dump
--

\restrict fcBX2iK9YGsSgmXa5Eh5i8q0mNwCSbKGHgmmnksDHCPpGazaPTd15TE58dd5wdg

-- Dumped from database version 17.9 (Homebrew)
-- Dumped by pg_dump version 17.9 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: active_outages(double precision, double precision, integer, integer); Type: FUNCTION; Schema: public; Owner: thanhpham
--

CREATE FUNCTION public.active_outages(p_lat double precision, p_lng double precision, p_radius_m integer DEFAULT 5000, p_hours integer DEFAULT 6) RETURNS TABLE(carrier_name text, outage_type text, report_count integer, first_reported timestamp with time zone, last_reported timestamp with time zone, affected_areas text[])
    LANGUAGE sql STABLE
    AS $$
  SELECT
    o.carrier_name,
    o.outage_type,
    COUNT(*)::int AS report_count,
    MIN(o.reported_at) AS first_reported,
    MAX(o.reported_at) AS last_reported,
    ARRAY_AGG(DISTINCT o.ward ORDER BY o.ward) FILTER (WHERE o.ward IS NOT NULL) AS affected_areas
  FROM outage_reports o
  WHERE
    o.reported_at > NOW() - (p_hours || ' hours')::interval
    AND o.resolved_at IS NULL
    AND 6371000 * 2 * ASIN(SQRT(
      POWER(SIN((RADIANS(o.latitude) - RADIANS(p_lat)) / 2), 2) +
      COS(RADIANS(p_lat)) * COS(RADIANS(o.latitude)) *
      POWER(SIN((RADIANS(o.longitude) - RADIANS(p_lng)) / 2), 2)
    )) <= p_radius_m
  GROUP BY o.carrier_name, o.outage_type
  HAVING COUNT(*) >= 3  -- Only show clusters of 3+ reports
  ORDER BY report_count DESC;
$$;


ALTER FUNCTION public.active_outages(p_lat double precision, p_lng double precision, p_radius_m integer, p_hours integer) OWNER TO thanhpham;

--
-- Name: coverage_grid(double precision, double precision, integer, text, text, integer); Type: FUNCTION; Schema: public; Owner: thanhpham
--

CREATE FUNCTION public.coverage_grid(p_lat double precision, p_lng double precision, p_radius_m integer DEFAULT 1000, p_carrier text DEFAULT NULL::text, p_network text DEFAULT NULL::text, p_days integer DEFAULT 30) RETURNS TABLE(carrier_name text, network_type text, sample_count integer, avg_download_mbps numeric, avg_upload_mbps numeric, avg_latency_ms numeric, avg_rsrp_dbm numeric, avg_sinr_db numeric, coverage_quality text)
    LANGUAGE sql STABLE
    AS $$
  WITH nearby AS (
    SELECT
      st.carrier_name,
      st.network_type,
      st.download_mbps,
      st.upload_mbps,
      st.latency_ms,
      ss.rsrp_dbm,
      ss.sinr_db
    FROM speed_tests st
    LEFT JOIN signal_samples ss ON ss.speed_test_id = st.id
    WHERE
      st.recorded_at > NOW() - (p_days || ' days')::interval
      AND (p_carrier IS NULL OR st.carrier_name = p_carrier)
      AND (p_network IS NULL OR st.network_type = p_network)
      AND 6371000 * 2 * ASIN(SQRT(
        POWER(SIN((RADIANS(st.latitude) - RADIANS(p_lat)) / 2), 2) +
        COS(RADIANS(p_lat)) * COS(RADIANS(st.latitude)) *
        POWER(SIN((RADIANS(st.longitude) - RADIANS(p_lng)) / 2), 2)
      )) <= p_radius_m
  )
  SELECT
    n.carrier_name,
    n.network_type,
    COUNT(*)::int AS sample_count,
    ROUND(AVG(n.download_mbps)::numeric, 2) AS avg_download_mbps,
    ROUND(AVG(n.upload_mbps)::numeric, 2) AS avg_upload_mbps,
    ROUND(AVG(n.latency_ms)::numeric, 0) AS avg_latency_ms,
    ROUND(AVG(n.rsrp_dbm)::numeric, 0) AS avg_rsrp_dbm,
    ROUND(AVG(n.sinr_db)::numeric, 1) AS avg_sinr_db,
    CASE
      WHEN AVG(n.download_mbps) >= 100 THEN 'excellent'
      WHEN AVG(n.download_mbps) >= 50  THEN 'good'
      WHEN AVG(n.download_mbps) >= 20  THEN 'fair'
      WHEN AVG(n.download_mbps) >= 5   THEN 'poor'
      ELSE 'very_poor'
    END AS coverage_quality
  FROM nearby n
  GROUP BY n.carrier_name, n.network_type
  ORDER BY avg_download_mbps DESC NULLS LAST;
$$;


ALTER FUNCTION public.coverage_grid(p_lat double precision, p_lng double precision, p_radius_m integer, p_carrier text, p_network text, p_days integer) OWNER TO thanhpham;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: devices; Type: TABLE; Schema: public; Owner: thanhpham
--

CREATE TABLE public.devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    device_uid text NOT NULL,
    platform text NOT NULL,
    os_version text,
    app_version text,
    device_model text,
    carrier_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT devices_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))
);


ALTER TABLE public.devices OWNER TO thanhpham;

--
-- Name: outage_reports; Type: TABLE; Schema: public; Owner: thanhpham
--

CREATE TABLE public.outage_reports (
    id bigint NOT NULL,
    device_id uuid NOT NULL,
    user_id uuid,
    carrier_name text NOT NULL,
    outage_type text NOT NULL,
    description text,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    province text,
    district text,
    ward text,
    is_verified boolean DEFAULT false,
    cluster_size integer DEFAULT 1,
    resolved_at timestamp with time zone,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outage_reports_latitude_check CHECK (((latitude >= (8)::double precision) AND (latitude <= (24)::double precision))),
    CONSTRAINT outage_reports_longitude_check CHECK (((longitude >= (102)::double precision) AND (longitude <= (110)::double precision))),
    CONSTRAINT outage_reports_outage_type_check CHECK ((outage_type = ANY (ARRAY['no_signal'::text, 'slow'::text, 'no_data'::text, 'no_call'::text, 'no_sms'::text, 'intermittent'::text])))
);


ALTER TABLE public.outage_reports OWNER TO thanhpham;

--
-- Name: outage_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: thanhpham
--

CREATE SEQUENCE public.outage_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.outage_reports_id_seq OWNER TO thanhpham;

--
-- Name: outage_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: thanhpham
--

ALTER SEQUENCE public.outage_reports_id_seq OWNED BY public.outage_reports.id;


--
-- Name: signal_samples; Type: TABLE; Schema: public; Owner: thanhpham
--

CREATE TABLE public.signal_samples (
    id bigint NOT NULL,
    device_id uuid NOT NULL,
    speed_test_id bigint,
    carrier_name text NOT NULL,
    network_type text NOT NULL,
    band text,
    rsrp_dbm integer,
    rsrq_db numeric(5,2),
    sinr_db numeric(5,2),
    rssi_dbm integer,
    cqi integer,
    cell_id bigint,
    pci integer,
    tac integer,
    mcc integer,
    mnc integer,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    altitude_m integer,
    location_accuracy_m integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT signal_samples_latitude_check CHECK (((latitude >= (8)::double precision) AND (latitude <= (24)::double precision))),
    CONSTRAINT signal_samples_longitude_check CHECK (((longitude >= (102)::double precision) AND (longitude <= (110)::double precision)))
);


ALTER TABLE public.signal_samples OWNER TO thanhpham;

--
-- Name: signal_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: thanhpham
--

CREATE SEQUENCE public.signal_samples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.signal_samples_id_seq OWNER TO thanhpham;

--
-- Name: signal_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: thanhpham
--

ALTER SEQUENCE public.signal_samples_id_seq OWNED BY public.signal_samples.id;


--
-- Name: speed_tests; Type: TABLE; Schema: public; Owner: thanhpham
--

CREATE TABLE public.speed_tests (
    id bigint NOT NULL,
    device_id uuid NOT NULL,
    user_id uuid,
    carrier_name text NOT NULL,
    network_type text NOT NULL,
    is_roaming boolean DEFAULT false,
    download_mbps numeric(8,2) NOT NULL,
    upload_mbps numeric(8,2) NOT NULL,
    latency_ms integer NOT NULL,
    jitter_ms integer,
    packet_loss_pct numeric(5,2),
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    altitude_m integer,
    location_accuracy_m integer,
    province text,
    district text,
    ward text,
    building_name text,
    test_duration_ms integer,
    test_server text,
    test_type text DEFAULT 'manual'::text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    client_time timestamp with time zone,
    CONSTRAINT speed_tests_latitude_check CHECK (((latitude >= (8)::double precision) AND (latitude <= (24)::double precision))),
    CONSTRAINT speed_tests_longitude_check CHECK (((longitude >= (102)::double precision) AND (longitude <= (110)::double precision))),
    CONSTRAINT speed_tests_test_type_check CHECK ((test_type = ANY (ARRAY['manual'::text, 'passive'::text, 'scheduled'::text])))
);


ALTER TABLE public.speed_tests OWNER TO thanhpham;

--
-- Name: speed_tests_id_seq; Type: SEQUENCE; Schema: public; Owner: thanhpham
--

CREATE SEQUENCE public.speed_tests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.speed_tests_id_seq OWNER TO thanhpham;

--
-- Name: speed_tests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: thanhpham
--

ALTER SEQUENCE public.speed_tests_id_seq OWNED BY public.speed_tests.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: thanhpham
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone text,
    display_name text,
    role text DEFAULT 'consumer'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['consumer'::text, 'operator'::text, 'admin'::text])))
);


ALTER TABLE public.users OWNER TO thanhpham;

--
-- Name: outage_reports id; Type: DEFAULT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.outage_reports ALTER COLUMN id SET DEFAULT nextval('public.outage_reports_id_seq'::regclass);


--
-- Name: signal_samples id; Type: DEFAULT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.signal_samples ALTER COLUMN id SET DEFAULT nextval('public.signal_samples_id_seq'::regclass);


--
-- Name: speed_tests id; Type: DEFAULT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.speed_tests ALTER COLUMN id SET DEFAULT nextval('public.speed_tests_id_seq'::regclass);


--
-- Data for Name: devices; Type: TABLE DATA; Schema: public; Owner: thanhpham
--

COPY public.devices (id, user_id, device_uid, platform, os_version, app_version, device_model, carrier_name, created_at, last_seen) FROM stdin;
141a0c87-0d83-44d6-99ca-a4e603a378dd	\N	speed-1777428447350-69621	ios	\N	\N	\N	Viettel	2026-04-29 09:07:27.355794+07	2026-04-29 09:07:27.364655+07
\.


--
-- Data for Name: outage_reports; Type: TABLE DATA; Schema: public; Owner: thanhpham
--

COPY public.outage_reports (id, device_id, user_id, carrier_name, outage_type, description, latitude, longitude, province, district, ward, is_verified, cluster_size, resolved_at, reported_at) FROM stdin;
\.


--
-- Data for Name: signal_samples; Type: TABLE DATA; Schema: public; Owner: thanhpham
--

COPY public.signal_samples (id, device_id, speed_test_id, carrier_name, network_type, band, rsrp_dbm, rsrq_db, sinr_db, rssi_dbm, cqi, cell_id, pci, tac, mcc, mnc, latitude, longitude, altitude_m, location_accuracy_m, recorded_at) FROM stdin;
1	141a0c87-0d83-44d6-99ca-a4e603a378dd	1	Viettel	5G	n78	-85	\N	12.50	\N	\N	12345	\N	\N	\N	\N	16.05397578418082	108.2019117036436	\N	\N	2026-04-29 09:07:27.363589+07
\.


--
-- Data for Name: speed_tests; Type: TABLE DATA; Schema: public; Owner: thanhpham
--

COPY public.speed_tests (id, device_id, user_id, carrier_name, network_type, is_roaming, download_mbps, upload_mbps, latency_ms, jitter_ms, packet_loss_pct, latitude, longitude, altitude_m, location_accuracy_m, province, district, ward, building_name, test_duration_ms, test_server, test_type, recorded_at, client_time) FROM stdin;
1	141a0c87-0d83-44d6-99ca-a4e603a378dd	\N	Viettel	5G	f	350.50	80.20	18	\N	\N	16.05397578418082	108.2019117036436	\N	\N	Da Nang	Hai Chau	\N	\N	\N	\N	manual	2026-04-29 09:07:27.361743+07	\N
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: thanhpham
--

COPY public.users (id, phone, display_name, role, created_at, last_active) FROM stdin;
\.


--
-- Name: outage_reports_id_seq; Type: SEQUENCE SET; Schema: public; Owner: thanhpham
--

SELECT pg_catalog.setval('public.outage_reports_id_seq', 1, false);


--
-- Name: signal_samples_id_seq; Type: SEQUENCE SET; Schema: public; Owner: thanhpham
--

SELECT pg_catalog.setval('public.signal_samples_id_seq', 1, true);


--
-- Name: speed_tests_id_seq; Type: SEQUENCE SET; Schema: public; Owner: thanhpham
--

SELECT pg_catalog.setval('public.speed_tests_id_seq', 1, true);


--
-- Name: devices devices_device_uid_key; Type: CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_device_uid_key UNIQUE (device_uid);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: outage_reports outage_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.outage_reports
    ADD CONSTRAINT outage_reports_pkey PRIMARY KEY (id);


--
-- Name: signal_samples signal_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.signal_samples
    ADD CONSTRAINT signal_samples_pkey PRIMARY KEY (id);


--
-- Name: speed_tests speed_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.speed_tests
    ADD CONSTRAINT speed_tests_pkey PRIMARY KEY (id);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_devices_carrier; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_devices_carrier ON public.devices USING btree (carrier_name);


--
-- Name: idx_devices_user; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_devices_user ON public.devices USING btree (user_id);


--
-- Name: idx_outage_carrier; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_outage_carrier ON public.outage_reports USING btree (carrier_name);


--
-- Name: idx_outage_geo; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_outage_geo ON public.outage_reports USING btree (latitude, longitude);


--
-- Name: idx_outage_province; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_outage_province ON public.outage_reports USING btree (province);


--
-- Name: idx_outage_reported; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_outage_reported ON public.outage_reports USING btree (reported_at DESC);


--
-- Name: idx_signal_carrier; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_signal_carrier ON public.signal_samples USING btree (carrier_name);


--
-- Name: idx_signal_cell; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_signal_cell ON public.signal_samples USING btree (cell_id);


--
-- Name: idx_signal_geo; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_signal_geo ON public.signal_samples USING btree (latitude, longitude);


--
-- Name: idx_signal_recorded; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_signal_recorded ON public.signal_samples USING btree (recorded_at DESC);


--
-- Name: idx_speed_tests_carrier; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_speed_tests_carrier ON public.speed_tests USING btree (carrier_name);


--
-- Name: idx_speed_tests_device; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_speed_tests_device ON public.speed_tests USING btree (device_id, recorded_at DESC);


--
-- Name: idx_speed_tests_geo; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_speed_tests_geo ON public.speed_tests USING btree (latitude, longitude);


--
-- Name: idx_speed_tests_province; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_speed_tests_province ON public.speed_tests USING btree (province);


--
-- Name: idx_speed_tests_recorded; Type: INDEX; Schema: public; Owner: thanhpham
--

CREATE INDEX idx_speed_tests_recorded ON public.speed_tests USING btree (recorded_at DESC);


--
-- Name: devices devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: outage_reports outage_reports_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.outage_reports
    ADD CONSTRAINT outage_reports_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: outage_reports outage_reports_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.outage_reports
    ADD CONSTRAINT outage_reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: signal_samples signal_samples_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.signal_samples
    ADD CONSTRAINT signal_samples_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: signal_samples signal_samples_speed_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.signal_samples
    ADD CONSTRAINT signal_samples_speed_test_id_fkey FOREIGN KEY (speed_test_id) REFERENCES public.speed_tests(id) ON DELETE SET NULL;


--
-- Name: speed_tests speed_tests_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.speed_tests
    ADD CONSTRAINT speed_tests_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;


--
-- Name: speed_tests speed_tests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: thanhpham
--

ALTER TABLE ONLY public.speed_tests
    ADD CONSTRAINT speed_tests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict fcBX2iK9YGsSgmXa5Eh5i8q0mNwCSbKGHgmmnksDHCPpGazaPTd15TE58dd5wdg

